import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  MikroORM,
  PostgreSqlDriver,
} from '@mikro-orm/postgresql';

import { WalletEntity } from '../../src/domain/wallet/wallet.entity.js';
import { LedgerEntryEntity } from '../../src/domain/ledger/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../src/domain/wager/wager-transaction.entity.js';
import { IdempotencyRecordEntity } from '../../src/domain/idempotency/idempotency-record.entity.js';

import { OutboxEventEntity } from '../../src/infrastructure/outbox/outbox-event.entity.js';

import { CreateWalletService } from '../../src/application/wallet/create-wallet.service.js';
import { ProcessWagerService } from '../../src/application/wager/process-wager.service.js';

import type { ProcessWagerInput } from '../../src/application/wager/process-wager.input.js';

describe(
  'Financial invariants - integration',
  () => {
    let orm:
      MikroORM<PostgreSqlDriver>;

    beforeAll(async () => {
      orm =
        await MikroORM.init<PostgreSqlDriver>({
          driver:
            PostgreSqlDriver,

          host:
            process.env
              .DATABASE_HOST ??
            '127.0.0.1',

          port:
            Number(
              process.env
                .DATABASE_PORT ??
                '55432',
            ),

          dbName:
            process.env
              .DATABASE_NAME ??
            'jungle_wagering',

          user:
            process.env
              .DATABASE_USER ??
            'jungle',

          password:
            process.env
              .DATABASE_PASSWORD ??
            'jungle',

          entities: [
            WalletEntity,
            LedgerEntryEntity,
            WagerTransactionEntity,
            IdempotencyRecordEntity,
            OutboxEventEntity,
          ],

          debug:
            false,
        });
    });

    beforeEach(async () => {
      const em =
        orm.em.fork();

      await em.nativeDelete(
        OutboxEventEntity,
        {},
      );

      await em.nativeDelete(
        LedgerEntryEntity,
        {},
      );

      await em.nativeDelete(
        WagerTransactionEntity,
        {},
      );

      await em.nativeDelete(
        IdempotencyRecordEntity,
        {},
      );

      await em.nativeDelete(
        WalletEntity,
        {},
      );
    });

    afterAll(async () => {
      await orm.close(
        true,
      );
    });

    function createInput(
      overrides:
        Partial<ProcessWagerInput>,
    ): ProcessWagerInput {
      return {
        idempotencyKey:
          'provider-invariant:default',

        transactionId:
          'internal-invariant-default',

        providerId:
          'provider-invariant',

        externalTransactionId:
          'external-invariant-default',

        playerId:
          'player-invariant',

        walletId:
          '00000000-0000-4000-8000-000000000001',

        roundId:
          'round-invariant',

        gameId:
          'game-invariant',

        type:
          'BET',

        amount:
          '25.00',

        currency:
          'BRL',

        ...overrides,
      };
    }

    test(
      'keeps wallet, ledger, transaction and version invariants consistent across a full wager lifecycle',
      async () => {
        const playerId =
          'player-final-invariant';

        const roundId =
          'round-final-invariant';

        const gameId =
          'game-final-invariant';

        const walletService =
          new CreateWalletService(
            orm.em.fork(),
          );

        const wallet =
          await walletService.execute(
            {
              playerId,

              initialBalance: {
                amount:
                  '100.00',

                currency:
                  'BRL',
              },
            },
          );

        expect(
          wallet.balance.amount,
        ).toBe(
          '100.00',
        );

        expect(
          wallet.version,
        ).toBe(
          1,
        );

        const wagerService =
          new ProcessWagerService(
            orm.em.fork(),
          );

        const bet =
          await wagerService.execute(
            createInput({
              idempotencyKey:
                'provider-invariant:bet-1',

              transactionId:
                'internal-bet-1',

              externalTransactionId:
                'external-bet-1',

              playerId,

              walletId:
                wallet.id,

              roundId,

              gameId,

              type:
                'BET',

              amount:
                '25.00',
            }),
          );

        expect(
          bet?.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          bet?.balance.amount,
        ).toBe(
          '75.00',
        );

        const win =
          await wagerService.execute(
            createInput({
              idempotencyKey:
                'provider-invariant:win-1',

              transactionId:
                'internal-win-1',

              externalTransactionId:
                'external-win-1',

              playerId,

              walletId:
                wallet.id,

              roundId,

              gameId,

              type:
                'WIN',

              amount:
                '10.00',
            }),
          );

        expect(
          win?.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          win?.balance.amount,
        ).toBe(
          '85.00',
        );

        const loss =
          await wagerService.execute(
            createInput({
              idempotencyKey:
                'provider-invariant:loss-1',

              transactionId:
                'internal-loss-1',

              externalTransactionId:
                'external-loss-1',

              playerId,

              walletId:
                wallet.id,

              roundId,

              gameId,

              type:
                'LOSS',

              amount:
                '5.00',
            }),
          );

        expect(
          loss?.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          loss?.balance.amount,
        ).toBe(
          '85.00',
        );

        const refund =
          await wagerService.execute(
            createInput({
              idempotencyKey:
                'provider-invariant:refund-1',

              transactionId:
                'internal-refund-1',

              externalTransactionId:
                'external-refund-1',

              referenceExternalTransactionId:
                'external-bet-1',

              playerId,

              walletId:
                wallet.id,

              roundId,

              gameId,

              type:
                'REFUND',

              amount:
                '25.00',
            }),
          );

        expect(
          refund?.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          refund?.balance.amount,
        ).toBe(
          '110.00',
        );

        const rollback =
          await wagerService.execute(
            createInput({
              idempotencyKey:
                'provider-invariant:rollback-1',

              transactionId:
                'internal-rollback-1',

              externalTransactionId:
                'external-rollback-1',

              referenceExternalTransactionId:
                'external-win-1',

              playerId,

              walletId:
                wallet.id,

              roundId,

              gameId,

              type:
                'ROLLBACK',

              amount:
                '10.00',
            }),
          );

        expect(
          rollback?.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          rollback?.balance.amount,
        ).toBe(
          '100.00',
        );

        const verificationEm =
          orm.em.fork();

        const persistedWallet =
          await verificationEm
            .findOneOrFail(
              WalletEntity,
              {
                id:
                  wallet.id,
              },
            );

        const ledgerEntries =
          await verificationEm.find(
            LedgerEntryEntity,
            {
              walletId:
                wallet.id,
            },
            {
              orderBy: {
                createdAt:
                  'asc',
              },
            },
          );

        const transactions =
          await verificationEm.find(
            WagerTransactionEntity,
            {
              walletId:
                wallet.id,
            },
          );

        expect(
          persistedWallet.balance,
        ).toBe(
          '100.00',
        );

        /*
         * A carteira inicia na versão 1.
         *
         * BET, WIN, REFUND e ROLLBACK
         * alteram saldo: +4 versões.
         *
         * LOSS não altera saldo e,
         * portanto, não incrementa versão.
         */
        expect(
          persistedWallet.version,
        ).toBe(
          5,
        );

        const processedTransactions =
          transactions.filter(
            (transaction) =>
              transaction.status ===
              'PROCESSED',
          );

        expect(
          processedTransactions,
        ).toHaveLength(
          6,
        );

        const opening =
          processedTransactions.find(
            (transaction) =>
              transaction.type ===
              'OPENING',
          );

        const persistedLoss =
          processedTransactions.find(
            (transaction) =>
              transaction.type ===
              'LOSS',
          );

        const persistedRefund =
          processedTransactions.find(
            (transaction) =>
              transaction.type ===
              'REFUND',
          );

        const persistedRollback =
          processedTransactions.find(
            (transaction) =>
              transaction.type ===
              'ROLLBACK',
          );

        expect(
          opening,
        ).toBeDefined();

        expect(
          persistedLoss,
        ).toBeDefined();

        expect(
          persistedRefund
            ?.referenceTransactionId,
        ).toBe(
          'internal-bet-1',
        );

        expect(
          persistedRollback
            ?.referenceTransactionId,
        ).toBe(
          'internal-win-1',
        );

        /*
         * OPENING, BET, WIN, REFUND e
         * ROLLBACK alteram saldo.
         *
         * LOSS é financeiro para histórico,
         * mas não produz lançamento no ledger.
         */
        expect(
          ledgerEntries,
        ).toHaveLength(
          5,
        );

        const lossLedgerEntries =
          ledgerEntries.filter(
            (entry) =>
              entry.entryType ===
              'LOSS',
          );

        expect(
          lossLedgerEntries,
        ).toHaveLength(
          0,
        );

        /*
         * Cada lançamento deve começar
         * exatamente onde o anterior terminou.
         */
        for (
          let index = 1;
          index <
          ledgerEntries.length;
          index += 1
        ) {
          expect(
            ledgerEntries[
              index
            ]?.balanceBefore,
          ).toBe(
            ledgerEntries[
              index - 1
            ]?.balanceAfter,
          );
        }

        expect(
          ledgerEntries[0]
            ?.balanceBefore,
        ).toBe(
          '0.00',
        );

        expect(
          ledgerEntries[
            ledgerEntries.length -
              1
          ]?.balanceAfter,
        ).toBe(
          persistedWallet.balance,
        );

        /*
         * Reconstrução independente:
         * saldo = créditos - débitos.
         *
         * Usa centavos inteiros apenas no
         * teste para evitar qualquer float.
         */
        const toCents = (
          amount: string,
        ): bigint => {
          const [
            whole,
            decimal = '00',
          ] =
            amount.split(
              '.',
            );

          return (
            BigInt(
              whole,
            ) *
              100n +
            BigInt(
              decimal.padEnd(
                2,
                '0',
              ),
            )
          );
        };

        const ledgerNetCents =
          ledgerEntries.reduce(
            (
              total,
              entry,
            ) => {
              const cents =
                toCents(
                  entry.amount,
                );

              return entry.direction ===
                'CREDIT'
                ? total +
                    cents
                : total -
                    cents;
            },
            0n,
          );

        expect(
          ledgerNetCents,
        ).toBe(
          toCents(
            persistedWallet.balance,
          ),
        );

        expect(
          ledgerNetCents,
        ).toBe(
          10000n,
        );
      },
    );
  },
);
