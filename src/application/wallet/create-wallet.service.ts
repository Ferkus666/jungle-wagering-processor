import {
  Injectable,
} from '@nestjs/common';

import {
  EntityManager,
} from '@mikro-orm/postgresql';

import {
  randomUUID,
  createHash,
} from 'node:crypto';

import {
  Money,
} from '../../domain/money/money.js';

import {
  Wallet,
} from '../../domain/wallet/wallet.js';

import {
  WalletEntity,
} from '../../domain/wallet/wallet.entity.js';

import {
  LedgerEntryEntity,
} from '../../domain/ledger/ledger-entry.entity.js';

import {
  WagerTransactionEntity,
} from '../../domain/wager/wager-transaction.entity.js';

import {
  OutboxEventFactory,
} from '../../infrastructure/outbox/outbox-event.factory.js';

export interface CreateWalletInput {
  playerId: string;

  initialBalance: {
    amount: string;
    currency: string;
  };
}

export interface CreateWalletResult {
  id: string;
  playerId: string;

  balance: {
    amount: string;
    currency: string;
  };

  version: number;
}

@Injectable()
export class CreateWalletService {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async execute(
    input: CreateWalletInput,
  ): Promise<CreateWalletResult> {
    const initialBalance =
      Money.from(
        input.initialBalance.amount,
        input.initialBalance.currency,
      );

    if (initialBalance.isNegative()) {
      throw new Error(
        'INITIAL_BALANCE_CANNOT_BE_NEGATIVE',
      );
    }

    try {
      return await this.em.transactional(
        async (em) => {
          const existingWallet =
            await em.findOne(
              WalletEntity,
              {
                playerId:
                  input.playerId,

                currency:
                  input.initialBalance.currency,
              },
            );

          if (existingWallet) {
            throw new Error(
              'WALLET_ALREADY_EXISTS',
            );
          }

          const walletId =
            randomUUID();

          const wallet =
            Wallet.open(
              walletId,
              input.playerId,
              initialBalance,
            );

          const walletEntity =
            em.create(
              WalletEntity,
              {
                id:
                  wallet.getId(),

                playerId:
                  wallet.getPlayerId(),

                currency:
                  wallet
                    .getBalance()
                    .getCurrency(),

                balance:
                  wallet
                    .getBalance()
                    .getAmount(),

                version:
                  wallet.getVersion(),

                createdAt:
                  new Date(),

                updatedAt:
                  new Date(),
              },
            );

          em.persist(
            walletEntity,
          );

          /*
           * Saldo inicial maior que zero
           * precisa ser auditável.
           *
           * Por isso criamos uma transação
           * interna OPENING e o respectivo
           * lançamento CREDIT no mesmo
           * transaction do PostgreSQL.
           */
          if (
            initialBalance.isPositive()
          ) {
            const openingTransactionId =
              randomUUID();

            const openingExternalId =
              `opening:${walletId}`;

            const payloadHash =
              createHash('sha256')
                .update(
                  JSON.stringify({
                    walletId,
                    playerId:
                      input.playerId,
                    kind:
                      'OPENING',
                    money: {
                      amount:
                        initialBalance
                          .getAmount(),
                      currency:
                        initialBalance
                          .getCurrency(),
                    },
                  }),
                )
                .digest('hex');

            const now =
              new Date();

            em.persist(
              em.create(
                WagerTransactionEntity,
                {
                  id:
                    randomUUID(),

                  transactionId:
                    openingTransactionId,

                  providerId:
                    'INTERNAL',

                  externalTransactionId:
                    openingExternalId,

                  idempotencyKey:
                    openingExternalId,

                  payloadHash,

                  walletId,

                  playerId:
                    input.playerId,

                  roundId:
                    openingExternalId,

                  gameId:
                    'INTERNAL',

                  type:
                    'OPENING',

                  amount:
                    initialBalance
                      .getAmount(),

                  currency:
                    initialBalance
                      .getCurrency(),

                  status:
                    'PROCESSED',

                  referenceRetryCount:
                    0,

                  processedAt:
                    now,

                  createdAt:
                    now,

                  updatedAt:
                    now,
                },
              ),
            );

            em.persist(
              em.create(
                LedgerEntryEntity,
                {
                  id:
                    randomUUID(),

                  walletId,

                  playerId:
                    input.playerId,

                  transactionId:
                    openingTransactionId,

                  entryType:
                    'OPENING',

                  direction:
                    'CREDIT',

                  currency:
                    initialBalance
                      .getCurrency(),

                  amount:
                    initialBalance
                      .getAmount(),

                  balanceBefore:
                    Money.zero(
                      initialBalance.getCurrency(),
                    ).getAmount(),

                  balanceAfter:
                    initialBalance
                      .getAmount(),

                  createdAt:
                    now,
                },
              ),
            );

            em.persist(
              OutboxEventFactory
                .walletBalanceChanged({
                  walletId,

                  playerId:
                    input.playerId,

                  transactionId:
                    openingTransactionId,

                  amount:
                    initialBalance
                      .getAmount(),

                  currency:
                    initialBalance
                      .getCurrency(),
                }),
            );
          }

          await em.flush();

          return {
            id:
              walletEntity.id,

            playerId:
              walletEntity.playerId,

            balance: {
              amount:
                walletEntity.balance,

              currency:
                walletEntity.currency,
            },

            version:
              walletEntity.version,
          };
        },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          'WALLET_ALREADY_EXISTS'
      ) {
        throw error;
      }

      /*
       * A consulta anterior melhora a
       * mensagem no fluxo normal, mas a
       * UNIQUE(playerId, currency) do banco
       * continua sendo a proteção final em
       * criação concorrente.
       */
      const message =
        error instanceof Error
          ? error.message
          : '';

      if (
        message.includes(
          'wallets_player_id_currency_unique',
        ) ||
        message.includes(
          'wallets_player_id_currency_unique',
        ) ||
        message.includes(
          'duplicate key value violates unique constraint',
        )
      ) {
        throw new Error(
          'WALLET_ALREADY_EXISTS',
        );
      }

      throw error;
    }
  }
}
