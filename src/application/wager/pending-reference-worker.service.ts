import { Injectable } from '@nestjs/common';
import {
  EntityManager,
  LockMode,
} from '@mikro-orm/postgresql';

import { randomUUID } from 'node:crypto';

import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';

import { WalletEntity } from '../../domain/wallet/wallet.entity.js';
import { LedgerEntryEntity } from '../../domain/ledger/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../domain/wager/wager-transaction.entity.js';

import { OutboxEventFactory } from '../../infrastructure/outbox/outbox-event.factory.js';
import { ObservabilityService } from '../../infrastructure/observability/observability.service.js';

@Injectable()
export class PendingReferenceWorkerService {
  constructor(
    private readonly em: EntityManager,
    private readonly maxAttempts = 5,
    private readonly baseBackoffSeconds = 5,
    private readonly observability?: ObservabilityService,
  ) {}

  async processDueOne(): Promise<boolean> {
    return this.em.transactional(async (em) => {
      const rows = (await em.execute(
        `
          select "id"
          from "wager_transactions"
          where
            "status" = 'PENDING_REFERENCE'
            and (
              "next_reference_retry_at" is null
              or "next_reference_retry_at" <= now()
            )
          order by "created_at" asc
          for update skip locked
          limit 1
        `,
      )) as Array<{ id: string }>;

      const selected = rows[0];

      if (!selected) {
        return false;
      }

      const pending = await em.findOne(
        WagerTransactionEntity,
        {
          id: selected.id,
        },
        {
          lockMode: LockMode.PESSIMISTIC_WRITE,
        },
      );

      if (
        !pending ||
        pending.status !== 'PENDING_REFERENCE'
      ) {
        return false;
      }

      if (
        pending.type !== 'REFUND' &&
        pending.type !== 'ROLLBACK'
      ) {
        pending.status = 'REJECTED';
        pending.failureCode =
          'INVALID_PENDING_REFERENCE_TYPE';
        pending.processedAt = new Date();

        this.persistRejectedEvent(
          em,
          pending,
        );

        await em.flush();

        this.recordRejected(
          pending,
          'INVALID_PENDING_REFERENCE_TYPE',
        );

        return true;
      }

      if (!pending.referenceExternalTransactionId) {
        pending.status = 'REJECTED';
        pending.failureCode =
          'REFERENCE_TRANSACTION_REQUIRED';
        pending.processedAt = new Date();

        this.persistRejectedEvent(
          em,
          pending,
        );

        await em.flush();

        this.recordRejected(
          pending,
          'REFERENCE_TRANSACTION_REQUIRED',
        );

        return true;
      }

      const referencedTransaction =
        await em.findOne(
          WagerTransactionEntity,
          {
            providerId: pending.providerId,
            externalTransactionId:
              pending.referenceExternalTransactionId,
          },
        );

      if (!referencedTransaction) {
        pending.referenceRetryCount += 1;

        if (
          pending.referenceRetryCount >=
          this.maxAttempts
        ) {
          pending.status = 'REJECTED';
          pending.failureCode =
            'REFERENCE_NOT_FOUND_AFTER_RETRIES';
          pending.nextReferenceRetryAt =
            undefined;
          pending.processedAt = new Date();

          this.persistRejectedEvent(
            em,
            pending,
          );

          await em.flush();

          this.recordRejected(
            pending,
            'REFERENCE_NOT_FOUND_AFTER_RETRIES',
          );

          return true;
        }

        const delaySeconds =
          this.calculateBackoffSeconds(
            pending.referenceRetryCount,
          );

        pending.nextReferenceRetryAt =
          new Date(
            Date.now() +
              delaySeconds * 1000,
          );

        await em.flush();

        this.observability?.incrementCounter(
          'pending_reference_retries_total',
          {
            type: pending.type,
          },
        );

        this.observability?.info(
          'pending_reference.retry_scheduled',
          {
            transactionId:
              pending.transactionId,
            walletId:
              pending.walletId,
            providerId:
              pending.providerId,
            status:
              pending.status,
            retryCount:
              pending.referenceRetryCount,
          },
        );

        return true;
      }

      const walletEntity =
        await em.findOne(
          WalletEntity,
          {
            id: pending.walletId,
            playerId: pending.playerId,
            currency: pending.currency,
          },
          {
            lockMode:
              LockMode.PESSIMISTIC_WRITE,
          },
        );

      if (!walletEntity) {
        throw new Error(
          'Wallet not found or does not match player/currency',
        );
      }

      const validationFailure =
        this.validateReference(
          pending,
          referencedTransaction,
        );

      if (validationFailure) {
        pending.status = 'REJECTED';
        pending.failureCode =
          validationFailure;
        pending.nextReferenceRetryAt =
          undefined;
        pending.processedAt = new Date();

        this.persistRejectedEvent(
          em,
          pending,
        );

        await em.flush();

        this.recordRejected(
          pending,
          validationFailure,
        );

        return true;
      }

      const existingReversal =
        await em.findOne(
          WagerTransactionEntity,
          {
            providerId: pending.providerId,
            referenceTransactionId:
              referencedTransaction.transactionId,
            type: pending.type,
            status: 'PROCESSED',
          },
        );

      if (
        existingReversal &&
        existingReversal.id !== pending.id
      ) {
        pending.status = 'REJECTED';

        pending.failureCode =
          pending.type === 'REFUND'
            ? 'REFERENCE_ALREADY_REFUNDED'
            : 'REFERENCE_ALREADY_ROLLED_BACK';

        pending.nextReferenceRetryAt =
          undefined;
        pending.processedAt = new Date();

        this.persistRejectedEvent(
          em,
          pending,
        );

        await em.flush();

        this.recordRejected(
          pending,
          pending.failureCode ??
            'REFERENCE_ALREADY_REVERSED',
        );

        return true;
      }

      const amount = Money.from(
        pending.amount,
        pending.currency,
      );

      const wallet = Wallet.rehydrate(
            walletEntity.id,
            walletEntity.playerId,
            Money.from(
              walletEntity.balance,
              walletEntity.currency,
            ),
            walletEntity.version,
          );

      if (pending.type === 'REFUND') {
        const balanceBefore =
          wallet.getBalance();

        wallet.credit(amount);

        const balanceAfter =
          wallet.getBalance();

        walletEntity.balance =
          wallet
            .getBalance()
            .getAmount();

            walletEntity.version =
              wallet.getVersion();

        em.persist(
          em.create(
            LedgerEntryEntity,
            {
              id: randomUUID(),
              walletId: walletEntity.id,
              playerId: pending.playerId,
              transactionId:
                pending.transactionId,
              entryType: 'REFUND',
              direction: 'CREDIT',
              currency: pending.currency,
              amount: amount.getAmount(),
              balanceBefore:
                balanceBefore.getAmount(),
              balanceAfter:
                balanceAfter.getAmount(),
              createdAt: new Date(),
            },
          ),
        );
      }

      if (pending.type === 'ROLLBACK') {
        if (
          referencedTransaction.type ===
          'BET'
        ) {
          const balanceBefore =
            wallet.getBalance();

          wallet.credit(amount);

          const balanceAfter =
            wallet.getBalance();

          walletEntity.balance =
            balanceAfter.getAmount();

            walletEntity.version =
              wallet.getVersion();

          em.persist(
            em.create(
              LedgerEntryEntity,
              {
                id: randomUUID(),
                walletId:
                  walletEntity.id,
                playerId:
                  pending.playerId,
                transactionId:
                  pending.transactionId,
                entryType: 'ROLLBACK',
                direction: 'CREDIT',
                currency:
                  pending.currency,
                amount:
                  amount.getAmount(),
                balanceBefore:
                  balanceBefore.getAmount(),
                balanceAfter:
                  balanceAfter.getAmount(),
                createdAt: new Date(),
              },
            ),
          );
        } else {
          const balanceBefore =
            wallet.getBalance();

          try {
            wallet.debit(amount);
          } catch (error) {
            if (
              error instanceof Error &&
              error.name ===
                'InsufficientFundsError'
            ) {
              pending.status =
                'REJECTED';

              pending.failureCode =
                'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE';

              pending.nextReferenceRetryAt =
                undefined;

              pending.processedAt =
                new Date();

              this.persistRejectedEvent(
                em,
                pending,
              );

              await em.flush();

              this.recordRejected(
                pending,
                'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
              );

              return true;
            }

            throw error;
          }

          const balanceAfter =
            wallet.getBalance();

          walletEntity.balance =
            balanceAfter.getAmount();

            walletEntity.version =
              wallet.getVersion();

          em.persist(
            em.create(
              LedgerEntryEntity,
              {
                id: randomUUID(),
                walletId:
                  walletEntity.id,
                playerId:
                  pending.playerId,
                transactionId:
                  pending.transactionId,
                entryType: 'ROLLBACK',
                direction: 'DEBIT',
                currency:
                  pending.currency,
                amount:
                  amount.getAmount(),
                balanceBefore:
                  balanceBefore.getAmount(),
                balanceAfter:
                  balanceAfter.getAmount(),
                createdAt: new Date(),
              },
            ),
          );
        }
      }

      pending.referenceTransactionId =
        referencedTransaction.transactionId;

      pending.status = 'PROCESSED';
      pending.failureCode = undefined;
      pending.nextReferenceRetryAt =
        undefined;
      pending.processedAt = new Date();

      em.persist(
        OutboxEventFactory.wagerProcessed(
          {
            transactionId:
              pending.transactionId,
            providerId:
              pending.providerId,
            externalTransactionId:
              pending.externalTransactionId,
            playerId: pending.playerId,
            walletId: pending.walletId,
            roundId: pending.roundId,
            gameId: pending.gameId,
            type: pending.type,
            amount: pending.amount,
            currency: pending.currency,
            status: pending.status,
          },
        ),
      );

      em.persist(
        OutboxEventFactory.walletBalanceChanged(
          {
            walletId: pending.walletId,
            playerId: pending.playerId,
            transactionId:
              pending.transactionId,
            amount:
              walletEntity.balance,
            currency:
              pending.currency,
          },
        ),
      );

      await em.flush();

      this.observability?.incrementCounter(
        'pending_reference_resolved_total',
        {
          type: pending.type,
        },
      );

      this.observability?.info(
        'pending_reference.resolved',
        {
          transactionId:
            pending.transactionId,
          walletId:
            pending.walletId,
          providerId:
            pending.providerId,
          status:
            pending.status,
          retryCount:
            pending.referenceRetryCount,
        },
      );

      return true;
    });
  }

  private recordRejected(
    transaction: WagerTransactionEntity,
    failureCode: string,
  ): void {
    this.observability?.incrementCounter(
      'pending_reference_rejected_total',
      {
        failureCode,
        type: transaction.type,
      },
    );

    this.observability?.warn(
      'pending_reference.rejected',
      {
        transactionId:
          transaction.transactionId,
        walletId:
          transaction.walletId,
        providerId:
          transaction.providerId,
        status:
          transaction.status,
        failureCode,
        retryCount:
          transaction.referenceRetryCount,
      },
    );
  }

  private calculateBackoffSeconds(
    retryCount: number,
  ): number {
    return Math.min(
      this.baseBackoffSeconds *
        2 **
          Math.max(
            retryCount - 1,
            0,
          ),
      300,
    );
  }

  private validateReference(
    pending: WagerTransactionEntity,
    reference: WagerTransactionEntity,
  ): string | undefined {
    if (
      reference.status !== 'PROCESSED'
    ) {
      return 'REFERENCE_NOT_PROCESSED';
    }

    if (
      reference.providerId !==
      pending.providerId
    ) {
      return 'REFERENCE_PROVIDER_MISMATCH';
    }

    if (
      reference.playerId !==
      pending.playerId
    ) {
      return 'REFERENCE_PLAYER_MISMATCH';
    }

    if (
      reference.walletId !==
      pending.walletId
    ) {
      return 'REFERENCE_WALLET_MISMATCH';
    }

    if (
      reference.currency !==
      pending.currency
    ) {
      return 'REFERENCE_CURRENCY_MISMATCH';
    }

    if (
      reference.roundId !==
      pending.roundId
    ) {
      return 'REFERENCE_ROUND_MISMATCH';
    }

    const pendingAmount =
      Money.from(
        pending.amount,
        pending.currency,
      );

    const referenceAmount =
      Money.from(
        reference.amount,
        reference.currency,
      );

    if (
      !pendingAmount.equals(
        referenceAmount,
      )
    ) {
      return 'REFERENCE_AMOUNT_MISMATCH';
    }

    if (
      pending.type === 'REFUND' &&
      reference.type !== 'BET'
    ) {
      return 'INVALID_REFERENCE_TYPE';
    }

    if (
      pending.type === 'ROLLBACK' &&
      reference.type !== 'BET' &&
      reference.type !== 'WIN' &&
      reference.type !== 'REFUND'
    ) {
      return 'INVALID_REFERENCE_TYPE';
    }

    return undefined;
  }

  private persistRejectedEvent(
    em: EntityManager,
    transaction: WagerTransactionEntity,
  ): void {
    em.persist(
      OutboxEventFactory.wagerRejected(
        {
          transactionId:
            transaction.transactionId,
          providerId:
            transaction.providerId,
          externalTransactionId:
            transaction.externalTransactionId,
          playerId:
            transaction.playerId,
          walletId:
            transaction.walletId,
          roundId:
            transaction.roundId,
          gameId:
            transaction.gameId,
          type:
            transaction.type,
          amount:
            transaction.amount,
          currency:
            transaction.currency,
          status:
            transaction.status,
          failureCode:
            transaction.failureCode,
        },
      ),
    );
  }
}