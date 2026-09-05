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

import { ProcessWagerService } from '../../src/application/wager/process-wager.service.js';
import { PendingReferenceWorkerService } from '../../src/application/wager/pending-reference-worker.service.js';

describe(
  'PendingReferenceWorkerService - integration',
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
      'resolves REFUND that arrived before its BET reference',
      async () => {
        const playerId =
          'player-pending-reference';

        const walletId =
          await createWallet(
            playerId,
          );

        const processService =
          new ProcessWagerService(
            orm.em.fork(),
          );

        /*
         * REFUND chega primeiro.
         */
        await processService.execute(
          {
            idempotencyKey:
              'refund-before-bet',

            transactionId:
              randomUUID(),

            providerId:
              'provider-a',

            externalTransactionId:
              'refund-external-1',

            playerId,

            walletId,

            roundId:
              'round-1',

            gameId:
              'game-1',

            type:
              'REFUND',

            amount:
              '25.00',

            currency:
              'BRL',

            referenceTransactionId:
              'bet-external-1',
          },
        );

        let verificationEm =
          orm.em.fork();

        let refund =
          await verificationEm.findOneOrFail(
            WagerTransactionEntity,
            {
              providerId:
                'provider-a',

              externalTransactionId:
                'refund-external-1',
            },
          );

        expect(
          refund.status,
        ).toBe(
          'PENDING_REFERENCE',
        );

        /*
         * O BET chega depois.
         */
        await processService.execute(
          {
            idempotencyKey:
              'bet-after-refund',

            transactionId:
              randomUUID(),

            providerId:
              'provider-a',

            externalTransactionId:
              'bet-external-1',

            playerId,

            walletId,

            roundId:
              'round-1',

            gameId:
              'game-1',

            type:
              'BET',

            amount:
              '25.00',

            currency:
              'BRL',
          },
        );

        verificationEm =
          orm.em.fork();

        let wallet =
          await verificationEm.findOneOrFail(
            WalletEntity,
            {
              id:
                walletId,
            },
          );

        expect(
          wallet.balance,
        ).toBe(
          '75.00',
        );

        /*
         * Worker encontra a referência
         * que agora existe e resolve
         * automaticamente o REFUND.
         */
        const worker =
          new PendingReferenceWorkerService(
            orm.em.fork(),
          );

        const processed =
          await worker.processDueOne();

        expect(
          processed,
        ).toBe(true);

        verificationEm =
          orm.em.fork();

        wallet =
          await verificationEm.findOneOrFail(
            WalletEntity,
            {
              id:
                walletId,
            },
          );

        refund =
          await verificationEm.findOneOrFail(
            WagerTransactionEntity,
            {
              providerId:
                'provider-a',

              externalTransactionId:
                'refund-external-1',
            },
          );

        const ledger =
          await verificationEm.find(
            LedgerEntryEntity,
            {
              walletId,
            },
            {
              orderBy: {
                createdAt:
                  'asc',
              },
            },
          );

        expect(
          wallet.balance,
        ).toBe(
          '100.00',
        );

        expect(
          refund.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          refund.failureCode,
        ).toBeNull();

        expect(
          refund.processedAt,
        ).not.toBeNull();

        /*
         * Um lançamento do BET e
         * um lançamento do REFUND.
         */
        expect(
          ledger,
        ).toHaveLength(
          2,
        );

        expect(
          ledger.map(
            (entry) =>
              entry.amount,
          ),
        ).toEqual([
          '25.00',
          '25.00',
        ]);
      },
    );

    test(
      'rejects pending reference after retry limit is exhausted',
      async () => {
        const playerId =
          'player-reference-never-arrives';

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
              'refund-never-resolved',

            transactionId:
              randomUUID(),

            providerId:
              'provider-a',

            externalTransactionId:
              'refund-never-resolved',

            playerId,

            walletId,

            roundId:
              'round-never',

            gameId:
              'game-never',

            type:
              'REFUND',

            amount:
              '25.00',

            currency:
              'BRL',

            referenceTransactionId:
              'missing-bet',
          },
        );

        /*
         * maxAttempts = 2
         * backoff = 0 para o teste
         * poder executar imediatamente.
         */
        const worker =
          new PendingReferenceWorkerService(
            orm.em.fork(),

            2,

            0,
          );

        const firstAttempt =
          await worker.processDueOne();

        expect(
          firstAttempt,
        ).toBe(true);

        let verificationEm =
          orm.em.fork();

        let transaction =
          await verificationEm.findOneOrFail(
            WagerTransactionEntity,
            {
              externalTransactionId:
                'refund-never-resolved',
            },
          );

        expect(
          transaction.status,
        ).toBe(
          'PENDING_REFERENCE',
        );

        expect(
          transaction.referenceRetryCount,
        ).toBe(
          1,
        );

        const secondAttempt =
          await worker.processDueOne();

        expect(
          secondAttempt,
        ).toBe(true);

        verificationEm =
          orm.em.fork();

        transaction =
          await verificationEm.findOneOrFail(
            WagerTransactionEntity,
            {
              externalTransactionId:
                'refund-never-resolved',
            },
          );

        const wallet =
          await verificationEm.findOneOrFail(
            WalletEntity,
            {
              id:
                walletId,
            },
          );

        const ledger =
          await verificationEm.find(
            LedgerEntryEntity,
            {
              walletId,
            },
          );

        expect(
          transaction.status,
        ).toBe(
          'REJECTED',
        );

        expect(
          transaction.failureCode,
        ).toBe(
          'REFERENCE_NOT_FOUND_AFTER_RETRIES',
        );

        expect(
          transaction.referenceRetryCount,
        ).toBe(
          2,
        );

        expect(
          transaction.processedAt,
        ).not.toBeNull();

        /*
         * Rejeição nunca altera saldo.
         */
        expect(
          wallet.balance,
        ).toBe(
          '100.00',
        );

        expect(
          ledger,
        ).toHaveLength(
          0,
        );
      },
    );
  },
);