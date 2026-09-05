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

import { randomUUID } from 'node:crypto';

import { WalletEntity } from '../../src/domain/wallet/wallet.entity.js';
import { LedgerEntryEntity } from '../../src/domain/ledger/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../src/domain/wager/wager-transaction.entity.js';
import { IdempotencyRecordEntity } from '../../src/domain/idempotency/idempotency-record.entity.js';

import { OutboxEventEntity } from '../../src/infrastructure/outbox/outbox-event.entity.js';
import { ObservabilityService } from '../../src/infrastructure/observability/observability.service.js';

import { ProcessWagerService } from '../../src/application/wager/process-wager.service.js';

import type { ProcessWagerInput } from '../../src/application/wager/process-wager.input.js';

describe(
  'Lock observability - integration',
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

    async function createWallet(
      playerId: string,
      balance = '100.00',
    ): Promise<string> {
      const em =
        orm.em.fork();

      const walletId =
        randomUUID();

      em.persist(
        em.create(
          WalletEntity,
          {
            id:
              walletId,

            playerId,

            currency:
              'BRL',

            balance,

            createdAt:
              new Date(),

            updatedAt:
              new Date(),
          },
        ),
      );

      await em.flush();

      return walletId;
    }

    function createBetInput(
      walletId: string,
      playerId: string,
      idempotencyKey: string,
    ): ProcessWagerInput {
      return {
        idempotencyKey,

        transactionId:
          randomUUID(),

        providerId:
          'provider-lock-observability',

        externalTransactionId:
          randomUUID(),

        playerId,

        walletId,

        roundId:
          'round-lock-observability',

        gameId:
          'game-lock-observability',

        type:
          'BET',

        amount:
          '10.00',

        currency:
          'BRL',
      };
    }

    async function waitForMetric(
      observability: ObservabilityService,
      metricName: string,
      lockType: string,
      timeoutMs = 2000,
    ): Promise<number> {
      const startedAt =
        Date.now();

      while (
        Date.now() -
          startedAt <
        timeoutMs
      ) {
        const metric =
          observability
            .snapshot()
            .counters
            .find(
              (entry) =>
                entry.name ===
                  metricName &&
                entry.labels
                  .lockType ===
                  lockType,
            );

        if (metric) {
          return metric.value;
        }

        await new Promise<void>(
          (resolve) =>
            setTimeout(
              resolve,
              10,
            ),
        );
      }

      return 0;
    }

    test(
      'records idempotency lock conflict and still processes safely after the lock is released',
      async () => {
        const playerId =
          'player-lock-observability';

        const walletId =
          await createWallet(
            playerId,
          );

        const idempotencyKey =
          'provider-lock-observability:shared-key';

        const observability =
          new ObservabilityService();

        const service =
          new ProcessWagerService(
            orm.em.fork(),
            observability,
          );

        let resolveLockAcquired:
          (() => void) |
          undefined;

        let releaseLock:
          (() => void) |
          undefined;

        const lockAcquired =
          new Promise<void>(
            (resolve) => {
              resolveLockAcquired =
                resolve;
            },
          );

        const lockRelease =
          new Promise<void>(
            (resolve) => {
              releaseLock =
                resolve;
            },
          );

        const lockHolder =
          orm.em
            .fork()
            .transactional(
              async (em) => {
                await em.execute(
                  `
                    select pg_advisory_xact_lock(
                      hashtext(?)::bigint
                    )
                  `,
                  [
                    idempotencyKey,
                  ],
                );

                resolveLockAcquired?.();

                await lockRelease;
              },
            );

        await lockAcquired;

        const processing =
          service.execute(
            createBetInput(
              walletId,
              playerId,
              idempotencyKey,
            ),
          );

        const conflictsBeforeRelease =
          await waitForMetric(
            observability,
            'lock_conflicts_total',
            'IDEMPOTENCY',
          );

        expect(
          conflictsBeforeRelease,
        ).toBe(
          1,
        );

        releaseLock?.();

        await lockHolder;

        const result =
          await processing;

        expect(
          result?.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          result?.balance.amount,
        ).toBe(
          '90.00',
        );

        const conflictMetric =
          observability
            .snapshot()
            .counters
            .find(
              (entry) =>
                entry.name ===
                  'lock_conflicts_total' &&
                entry.labels
                  .lockType ===
                  'IDEMPOTENCY',
            );

        expect(
          conflictMetric?.value,
        ).toBe(
          1,
        );

        const em =
          orm.em.fork();

        const transactions =
          await em.find(
            WagerTransactionEntity,
            {},
          );

        const ledgerEntries =
          await em.find(
            LedgerEntryEntity,
            {},
          );

        const wallet =
          await em.findOneOrFail(
            WalletEntity,
            {
              id:
                walletId,
            },
          );

        expect(
          transactions,
        ).toHaveLength(
          1,
        );

        expect(
          ledgerEntries,
        ).toHaveLength(
          1,
        );

        expect(
          wallet.balance,
        ).toBe(
          '90.00',
        );
      },
    );
  },
);
