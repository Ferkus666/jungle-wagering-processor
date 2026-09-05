import { Injectable } from '@nestjs/common';

import { EntityManager, LockMode } from '@mikro-orm/postgresql';

import { randomUUID } from 'node:crypto';

import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { WalletEntity } from '../../domain/wallet/wallet.entity.js';
import { LedgerEntryEntity } from '../../domain/ledger/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../domain/wager/wager-transaction.entity.js';
import { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import { IdempotencyRecordEntity } from '../../domain/idempotency/idempotency-record.entity.js';

import { createWagerPayloadHash } from '../../domain/idempotency/payload-hash.js';

import { InboxMessageEntity } from '../../infrastructure/inbox/inbox-message.entity.js';

import { OutboxEventFactory } from '../../infrastructure/outbox/outbox-event.factory.js';
import { ObservabilityService } from '../../infrastructure/observability/observability.service.js';

import type { ProcessWagerInput } from './process-wager.input.js';
import type { ProcessWagerContext } from './process-wager.context.js';
import type { ProcessWagerResult } from './process-wager.result.js';

type LedgerMovementDirection = 'CREDIT' | 'DEBIT';

@Injectable()
export class ProcessWagerService {
  constructor(
    private readonly em: EntityManager,
    private readonly observability?: ObservabilityService,
  ) {}

  /**
   * Serializa concorrência num recurso lógico (idempotencyKey, ou
   * consumerName+messageId do inbox) via advisory lock transacional.
   *
   * Diferente do lock pessimista da wallet (que só existe depois que a
   * wallet é localizada), este lock protege o trecho anterior a isso —
   * duas requisições idênticas em paralelo não podem colidir na criação
   * do registro de idempotência/inbox.
   */
  private async acquireAdvisoryLock(
    em: EntityManager,
    key: string,
    lockType: 'INBOX' | 'IDEMPOTENCY',
    context?: {
      messageId?: string;
      transactionId?: string;
      walletId?: string;
      providerId?: string;
    },
  ): Promise<void> {
    if (this.observability) {
      const rows = await em.execute<Array<{ acquired: boolean }>>(
        `select pg_try_advisory_xact_lock(hashtext(?)::bigint) as acquired`,
        [key],
      );

      const acquired = rows[0]?.acquired === true;

      if (acquired) {
        return;
      }

      this.observability.incrementCounter('lock_conflicts_total', { lockType });
      this.observability.warn('database.lock_conflict', { ...context, lockType });
    }

    await em.execute(`select pg_advisory_xact_lock(hashtext(?)::bigint)`, [key]);
  }

  /**
   * Aplica um crédito ou débito na wallet (aggregate de domínio + entity de
   * persistência) e grava o lançamento de ledger correspondente na mesma
   * transação. Usado por BET, WIN, LOSS-refund(REFUND) e ROLLBACK — todos os
   * casos em que uma transação afeta o saldo têm exatamente essa forma:
   * ler saldo antes, mover, ler saldo depois, persistir os dois lados juntos.
   *
   * Lança InsufficientFundsError se o débito deixaria o saldo negativo —
   * o chamador decide o failureCode apropriado para o contexto (BET sem
   * saldo é diferente de uma reversão que causaria saldo negativo).
   */
  private applyBalanceMovement(
    em: EntityManager,
    wallet: Wallet,
    walletEntity: WalletEntity,
    input: ProcessWagerInput,
    amount: Money,
    entryType: string,
    direction: LedgerMovementDirection,
  ): void {
    const balanceBefore = wallet.getBalance();

    if (direction === 'CREDIT') {
      wallet.credit(amount);
    } else {
      wallet.debit(amount);
    }

    const balanceAfter = wallet.getBalance();

    walletEntity.balance = balanceAfter.getAmount();
    walletEntity.version = wallet.getVersion();

    em.persist(
      em.create(LedgerEntryEntity, {
        id: randomUUID(),
        walletId: walletEntity.id,
        playerId: input.playerId,
        transactionId: input.transactionId,
        entryType,
        direction,
        currency: input.currency,
        amount: amount.getAmount(),
        balanceBefore: balanceBefore.getAmount(),
        balanceAfter: balanceAfter.getAmount(),
        createdAt: new Date(),
      }),
    );
  }

  /**
   * Valida se a transação referenciada por um REFUND/ROLLBACK realmente
   * corresponde à operação recebida (regra adicional 2 da seção 7 do
   * desafio). Retorna o failureCode da primeira regra violada, ou
   * `undefined` se a referência é válida.
   */
  private validateReferenceMatch(
    referencedTransaction: WagerTransactionEntity,
    input: ProcessWagerInput,
    amount: Money,
  ): string | undefined {
    if (referencedTransaction.status !== 'PROCESSED') {
      return 'REFERENCE_NOT_PROCESSED';
    }

    if (referencedTransaction.playerId !== input.playerId) {
      return 'REFERENCE_PLAYER_MISMATCH';
    }

    if (referencedTransaction.walletId !== input.walletId) {
      return 'REFERENCE_WALLET_MISMATCH';
    }

    if (referencedTransaction.currency !== input.currency) {
      return 'REFERENCE_CURRENCY_MISMATCH';
    }

    if (referencedTransaction.roundId !== input.roundId) {
      return 'REFERENCE_ROUND_MISMATCH';
    }

    const referenceAmount = Money.from(
      referencedTransaction.amount,
      referencedTransaction.currency,
    );

    if (!referenceAmount.equals(amount)) {
      return 'REFERENCE_AMOUNT_MISMATCH';
    }

    return undefined;
  }

  /**
   * Uma referência não pode ser revertida duas vezes pelo mesmo tipo de
   * operação (regra adicional 4 da seção 7). REFUND e ROLLBACK fazem
   * exatamente a mesma checagem, mudando apenas o `reversalType` buscado.
   */
  private async findExistingReversal(
    em: EntityManager,
    input: ProcessWagerInput,
    referencedTransactionId: string,
    reversalType: 'REFUND' | 'ROLLBACK',
  ): Promise<WagerTransactionEntity | null> {
    return em.findOne(WagerTransactionEntity, {
      providerId: input.providerId,
      referenceTransactionId: referencedTransactionId,
      type: reversalType,
      status: 'PROCESSED',
    });
  }

  async execute(
    input: ProcessWagerInput,
    context?: ProcessWagerContext,
  ): Promise<ProcessWagerResult | undefined> {
    if (
      input.type !== 'BET' &&
      input.type !== 'WIN' &&
      input.type !== 'LOSS' &&
      input.type !== 'REFUND' &&
      input.type !== 'ROLLBACK'
    ) {
      throw new Error('Unsupported wager type');
    }

    const referenceExternalTransactionId =
      input.referenceExternalTransactionId ?? input.referenceTransactionId;

    if (
      (input.type === 'REFUND' || input.type === 'ROLLBACK') &&
      !referenceExternalTransactionId
    ) {
      throw new Error('REFERENCE_TRANSACTION_REQUIRED');
    }

    const amount = Money.from(input.amount, input.currency);

    if (!amount.isPositive()) {
      throw new Error('Wager amount must be positive');
    }

    const payloadHash = createWagerPayloadHash(input);

    return this.em.transactional(async (em) => {
      /*
       * ------------------------------------------------
       * INBOX
       * ------------------------------------------------
       *
       * Quando a chamada veio do SQS, registramos a mensagem dentro da
       * MESMA transação financeira.
       */
      let inboxMessage: InboxMessageEntity | undefined;

      if (context?.inbox) {
        const inbox = context.inbox;

        await this.acquireAdvisoryLock(em, `${inbox.consumerName}:${inbox.messageId}`, 'INBOX', {
          messageId: inbox.messageId,
          transactionId: input.transactionId,
          walletId: input.walletId,
          providerId: input.providerId,
        });

        const existingInbox = await em.findOne(InboxMessageEntity, {
          consumerName: inbox.consumerName,
          messageId: inbox.messageId,
        });

        if (existingInbox) {
          if (existingInbox.payloadHash !== inbox.payloadHash) {
            throw new Error('INBOX_MESSAGE_CONFLICT');
          }

          /*
           * A mesma mensagem já foi processada e confirmada.
           */
          if (existingInbox.processedAt) {
            return;
          }

          inboxMessage = existingInbox;
        } else {
          inboxMessage = em.create(InboxMessageEntity, {
            id: randomUUID(),
            consumerName: inbox.consumerName,
            messageId: inbox.messageId,
            payloadHash: inbox.payloadHash,
            receivedAt: new Date(),
          });

          em.persist(inboxMessage);
        }
      }

      /*
       * ------------------------------------------------
       * IDEMPOTENCY LOCK
       * ------------------------------------------------
       */
      await this.acquireAdvisoryLock(em, input.idempotencyKey, 'IDEMPOTENCY', {
        messageId: context?.inbox?.messageId,
        transactionId: input.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
      });

      const existingIdempotencyRecord = await em.findOne(IdempotencyRecordEntity, {
        idempotencyKey: input.idempotencyKey,
      });

      if (existingIdempotencyRecord) {
        if (existingIdempotencyRecord.payloadHash !== payloadHash) {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        }

        /*
         * Pode ser uma nova mensagem SQS, com messageId diferente,
         * representando uma operação que já foi processada via
         * idempotência. Nesse caso o inbox dessa mensagem também
         * precisa ser concluído.
         */
        if (inboxMessage) {
          inboxMessage.processedAt = new Date();
          await em.flush();
        }

        if (existingIdempotencyRecord.responseBody) {
          const originalResult = JSON.parse(
            existingIdempotencyRecord.responseBody,
          ) as Omit<ProcessWagerResult, 'idempotentReplay'>;

          return { ...originalResult, idempotentReplay: true };
        }

        return undefined;
      }

      const existingTransaction = await em.findOne(WagerTransactionEntity, {
        transactionId: input.transactionId,
      });

      if (existingTransaction) {
        if (inboxMessage) {
          inboxMessage.processedAt = new Date();
          await em.flush();
        }

        return;
      }

      const existingProviderTransaction = await em.findOne(WagerTransactionEntity, {
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
      });

      if (existingProviderTransaction) {
        if (inboxMessage) {
          inboxMessage.processedAt = new Date();
          await em.flush();
        }

        return;
      }

      const idempotencyRecord = em.create(IdempotencyRecordEntity, {
        id: randomUUID(),
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        status: 'PROCESSING',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      em.persist(idempotencyRecord);

      /*
       * ------------------------------------------------
       * WALLET LOCK
       * ------------------------------------------------
       *
       * O lock é por wallet. Wallets diferentes continuam podendo ser
       * processadas em paralelo.
       */
      const walletEntity = await em.findOne(
        WalletEntity,
        {
          id: input.walletId,
          playerId: input.playerId,
          currency: input.currency,
        },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!walletEntity) {
        throw new Error('Wallet not found or does not match player/currency');
      }

      const wallet = Wallet.rehydrate(
        walletEntity.id,
        walletEntity.playerId,
        Money.from(walletEntity.balance, walletEntity.currency),
        walletEntity.version,
      );

      const createdAt = new Date();

      /*
       * O aggregate de domínio é a fonte das transições de estado. A
       * entity do MikroORM continua sendo responsável apenas pela
       * persistência.
       */
      const domainTransaction = WagerTransaction.create({
        id: input.transactionId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.type,
        money: amount,
        referenceExternalTransactionId,
        createdAt,
      });

      const wagerTransaction = em.create(WagerTransactionEntity, {
        id: randomUUID(),
        transactionId: input.transactionId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        type: input.type,
        amount: input.amount,
        currency: input.currency,
        status: domainTransaction.status,
        referenceRetryCount: 0,
        referenceExternalTransactionId,
        referenceTransactionId: undefined,
        createdAt,
        updatedAt: createdAt,
      });

      const syncDomainState = (): void => {
        wagerTransaction.status = domainTransaction.status;
        wagerTransaction.failureCode = domainTransaction.failureCode;
        wagerTransaction.processedAt = domainTransaction.processedAt;
        wagerTransaction.referenceTransactionId = domainTransaction.referenceTransactionId;
      };

      let balanceChanged = false;

      try {
        /*
         * ------------------------------------------------
         * BET
         * ------------------------------------------------
         */
        if (input.type === 'BET') {
          this.applyBalanceMovement(em, wallet, walletEntity, input, amount, 'BET', 'DEBIT');
          balanceChanged = true;

          domainTransaction.markProcessed(undefined, new Date());
          syncDomainState();
        }

        /*
         * ------------------------------------------------
         * WIN
         * ------------------------------------------------
         */
        if (input.type === 'WIN') {
          this.applyBalanceMovement(em, wallet, walletEntity, input, amount, 'WIN', 'CREDIT');
          balanceChanged = true;

          domainTransaction.markProcessed(undefined, new Date());
          syncDomainState();
        }

        /*
         * ------------------------------------------------
         * LOSS
         * ------------------------------------------------
         */
        if (input.type === 'LOSS') {
          domainTransaction.markProcessed(undefined, new Date());
          syncDomainState();
        }

        /*
         * ------------------------------------------------
         * REFUND / ROLLBACK
         * ------------------------------------------------
         */
        if (input.type === 'REFUND' || input.type === 'ROLLBACK') {
          const referencedTransaction = await em.findOne(WagerTransactionEntity, {
            providerId: input.providerId,
            externalTransactionId: referenceExternalTransactionId!,
          });

          if (!referencedTransaction) {
            /*
             * Referência ainda não chegou.
             */
            domainTransaction.markPendingReference();
            syncDomainState();
          } else {
            const referenceFailureCode = this.validateReferenceMatch(
              referencedTransaction,
              input,
              amount,
            );

            if (referenceFailureCode) {
              domainTransaction.reject(referenceFailureCode);
              syncDomainState();
            } else if (input.type === 'REFUND') {
              /*
               * REFUND só pode inverter BET.
               */
              if (referencedTransaction.type !== 'BET') {
                domainTransaction.reject('INVALID_REFERENCE_TYPE');
                syncDomainState();
              } else {
                const existingRefund = await this.findExistingReversal(
                  em,
                  input,
                  referencedTransaction.transactionId,
                  'REFUND',
                );

                if (existingRefund) {
                  domainTransaction.reject('REFERENCE_ALREADY_REFUNDED');
                  syncDomainState();
                } else {
                  this.applyBalanceMovement(
                    em,
                    wallet,
                    walletEntity,
                    input,
                    amount,
                    'REFUND',
                    'CREDIT',
                  );
                  balanceChanged = true;

                  domainTransaction.markProcessed(referencedTransaction.transactionId, new Date());
                  syncDomainState();
                }
              }
            } else {
              /*
               * ROLLBACK pode referenciar: BET, WIN, REFUND.
               */
              if (
                referencedTransaction.type !== 'BET' &&
                referencedTransaction.type !== 'WIN' &&
                referencedTransaction.type !== 'REFUND'
              ) {
                domainTransaction.reject('INVALID_REFERENCE_TYPE');
                syncDomainState();
              } else {
                const existingRollback = await this.findExistingReversal(
                  em,
                  input,
                  referencedTransaction.transactionId,
                  'ROLLBACK',
                );

                if (existingRollback) {
                  domainTransaction.reject('REFERENCE_ALREADY_ROLLED_BACK');
                  syncDomainState();
                } else if (referencedTransaction.type === 'BET') {
                  /*
                   * BET debitou. ROLLBACK precisa creditar.
                   */
                  this.applyBalanceMovement(
                    em,
                    wallet,
                    walletEntity,
                    input,
                    amount,
                    'ROLLBACK',
                    'CREDIT',
                  );
                  balanceChanged = true;

                  domainTransaction.markProcessed(referencedTransaction.transactionId, new Date());
                  syncDomainState();
                } else {
                  /*
                   * WIN ou REFUND creditou. O ROLLBACK precisa debitar,
                   * o que pode deixar o saldo negativo — diferente de BET
                   * sem saldo, por isso o failureCode próprio.
                   */
                  try {
                    this.applyBalanceMovement(
                      em,
                      wallet,
                      walletEntity,
                      input,
                      amount,
                      'ROLLBACK',
                      'DEBIT',
                    );
                    balanceChanged = true;

                    domainTransaction.markProcessed(
                      referencedTransaction.transactionId,
                      new Date(),
                    );
                    syncDomainState();
                  } catch (error) {
                    if (error instanceof Error && error.name === 'InsufficientFundsError') {
                      domainTransaction.reject('REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE');
                      syncDomainState();
                    } else {
                      throw error;
                    }
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        /*
         * BET sem saldo é uma rejeição de negócio, não uma falha
         * transiente da infraestrutura.
         */
        if (error instanceof Error && error.name === 'InsufficientFundsError') {
          domainTransaction.reject('INSUFFICIENT_FUNDS');
          syncDomainState();
        } else {
          throw error;
        }
      }

      em.persist(wagerTransaction);

      /*
       * ------------------------------------------------
       * TRANSACTIONAL OUTBOX
       * ------------------------------------------------
       */
      if (wagerTransaction.status === 'PROCESSED') {
        em.persist(
          OutboxEventFactory.wagerProcessed({
            transactionId: input.transactionId,
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
            playerId: input.playerId,
            walletId: input.walletId,
            roundId: input.roundId,
            gameId: input.gameId,
            type: input.type,
            amount: input.amount,
            currency: input.currency,
            status: wagerTransaction.status,
          }),
        );

        if (balanceChanged) {
          em.persist(
            OutboxEventFactory.walletBalanceChanged({
              walletId: input.walletId,
              playerId: input.playerId,
              transactionId: input.transactionId,
              amount: walletEntity.balance,
              currency: input.currency,
            }),
          );
        }
      }

      if (wagerTransaction.status === 'REJECTED') {
        em.persist(
          OutboxEventFactory.wagerRejected({
            transactionId: input.transactionId,
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
            playerId: input.playerId,
            walletId: input.walletId,
            roundId: input.roundId,
            gameId: input.gameId,
            type: input.type,
            amount: input.amount,
            currency: input.currency,
            status: wagerTransaction.status,
            failureCode: wagerTransaction.failureCode,
          }),
        );
      }

      if (wagerTransaction.status === 'PENDING_REFERENCE') {
        em.persist(
          OutboxEventFactory.wagerPendingReference({
            transactionId: input.transactionId,
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
            playerId: input.playerId,
            walletId: input.walletId,
            roundId: input.roundId,
            gameId: input.gameId,
            type: input.type,
            amount: input.amount,
            currency: input.currency,
            status: wagerTransaction.status,
          }),
        );
      }

      /*
       * A operação financeira terminou. Persistimos também o resultado
       * observado neste momento para que um replay futuro devolva
       * exatamente a resposta original.
       */
      const originalResult: Omit<ProcessWagerResult, 'idempotentReplay'> = {
        transactionId: wagerTransaction.transactionId,
        status: wagerTransaction.status,
        balance: {
          amount: walletEntity.balance,
          currency: walletEntity.currency,
        },
        ...(wagerTransaction.failureCode ? { failureCode: wagerTransaction.failureCode } : {}),
      };

      idempotencyRecord.status = 'COMPLETED';
      idempotencyRecord.responseBody = JSON.stringify(originalResult);

      /*
       * O inbox também só é marcado como processado no final. Portanto
       * inbox, wallet, ledger, wager, idempotency e outbox são
       * confirmados pelo MESMO commit.
       */
      if (inboxMessage) {
        inboxMessage.processedAt = new Date();
      }

      await em.flush();

      return { ...originalResult, idempotentReplay: false };
    });
  }
}
