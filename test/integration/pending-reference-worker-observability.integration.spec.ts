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

import { InboxMessageEntity } from '../../src/infrastructure/inbox/inbox-message.entity.js';
import { OutboxEventEntity } from '../../src/infrastructure/outbox/outbox-event.entity.js';
import { ObservabilityService } from '../../src/infrastructure/observability/observability.service.js';

import { ProcessWagerService } from '../../src/application/wager/process-wager.service.js';
import { PendingReferenceWorkerService } from '../../src/application/wager/pending-reference-worker.service.js';

describe(
  'PendingReferenceWorkerService observability - integration',
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
            InboxMessageEntity,
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
        InboxMessageEntity,
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

    test(
      'records resolved metric when a pending REFUND finds its BET reference',
      async () => {
        const playerId =
          'player-observability-resolved';

        const walletId =
          await createWallet(
            playerId,
          );

        const processService =
          new ProcessWagerService(
            orm.em.fork(),
          );

        await processService.execute(
          {
            idempotencyKey:
              'refund-observability-before-bet',

            transactionId:
              randomUUID(),

            providerId:
              'provider-observability',

            externalTransactionId:
              'refund-observability-1',

            playerId,

            walletId,

            roundId:
              'round-observability-1',

            gameId:
              'game-observability-1',

            type:
              'REFUND',

            amount:
              '25.00',

            currency:
              'BRL',

            referenceTransactionId:
              'bet-observability-1',
          },
        );

        await processService.execute(
          {
            idempotencyKey:
              'bet-observability-after-refund',

            transactionId:
              randomUUID(),

            providerId:
              'provider-observability',

            externalTransactionId:
              'bet-observability-1',

            playerId,

            walletId,

            roundId:
              'round-observability-1',

            gameId:
              'game-observability-1',

            type:
              'BET',

            amount:
              '25.00',

            currency:
              'BRL',
          },
        );

        const observability =
          new ObservabilityService();

        const worker =
          new PendingReferenceWorkerService(
            orm.em.fork(),

            5,

            0,

            observability,
          );

        const processed =
          await worker.processDueOne();

        expect(
          processed,
        ).toBe(
          true,
        );

        const snapshot =
          observability.snapshot();

        const resolvedCounter =
          snapshot.counters.find(
            (metric) =>
              metric.name ===
                'pending_reference_resolved_total' &&
              metric.labels.type ===
                'REFUND',
          );

        expect(
          resolvedCounter?.value,
        ).toBe(
          1,
        );

        const rejectedCounter =
          snapshot.counters.find(
            (metric) =>
              metric.name ===
              'pending_reference_rejected_total',
          );

        expect(
          rejectedCounter,
        ).toBeUndefined();
      },
    );

    test(
      'records retry and rejection metrics when a reference never arrives',
      async () => {
        const playerId =
          'player-observability-retry';

        const walletId =
          await createWallet(
            playerId,
          );

        const processService =
          new ProcessWagerService(
            orm.em.fork(),
          );

        await processService.execute(
          {
            idempotencyKey:
              'refund-observability-never-resolved',

            transactionId:
              randomUUID(),

            providerId:
              'provider-observability',

            externalTransactionId:
              'refund-observability-never-resolved',

            playerId,

            walletId,

            roundId:
              'round-observability-never',

            gameId:
              'game-observability-never',

            type:
              'REFUND',

            amount:
              '25.00',

            currency:
              'BRL',

            referenceTransactionId:
              'missing-bet-observability',
          },
        );

        const observability =
          new ObservabilityService();

        const worker =
          new PendingReferenceWorkerService(
            orm.em.fork(),

            2,

            0,

            observability,
          );

        expect(
          await worker.processDueOne(),
        ).toBe(
          true,
        );

        expect(
          await worker.processDueOne(),
        ).toBe(
          true,
        );

        const snapshot =
          observability.snapshot();

        const retryCounter =
          snapshot.counters.find(
            (metric) =>
              metric.name ===
                'pending_reference_retries_total' &&
              metric.labels.type ===
                'REFUND',
          );

        expect(
          retryCounter?.value,
        ).toBe(
          1,
        );

        const rejectedCounter =
          snapshot.counters.find(
            (metric) =>
              metric.name ===
                'pending_reference_rejected_total' &&
              metric.labels.type ===
                'REFUND' &&
              metric.labels.failureCode ===
                'REFERENCE_NOT_FOUND_AFTER_RETRIES',
          );

        expect(
          rejectedCounter?.value,
        ).toBe(
          1,
        );

        const resolvedCounter =
          snapshot.counters.find(
            (metric) =>
              metric.name ===
              'pending_reference_resolved_total',
          );

        expect(
          resolvedCounter,
        ).toBeUndefined();
      },
    );
  },
);
