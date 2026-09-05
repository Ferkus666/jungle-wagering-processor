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

import type { ProcessWagerInput } from '../../src/application/wager/process-wager.input.js';

describe(
  'Inbox + financial transaction - integration',
  () => {
    let orm: MikroORM<PostgreSqlDriver>;

    beforeAll(async () => {
      orm =
        await MikroORM.init<PostgreSqlDriver>({
          driver:
            PostgreSqlDriver,

          host:
            process.env
              .DATABASE_HOST ??
            '127.0.0.1',

          port: Number(
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

          debug: false,
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
      await orm.close(true);
    });

    async function createWallet(
      playerId: string,
      balance = '100.00',
    ): Promise<string> {
      const em =
        orm.em.fork();

      const walletId =
        randomUUID();

      const wallet =
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
        );

      em.persist(
        wallet,
      );

      await em.flush();

      return walletId;
    }

    function createInput(
      walletId: string,
      playerId: string,
    ): ProcessWagerInput {
      return {
        idempotencyKey:
          'provider-a:inbox-bet-1',

        transactionId:
          'internal-inbox-bet-1',

        providerId:
          'provider-a',

        externalTransactionId:
          'external-inbox-bet-1',

        playerId,

        walletId,

        roundId:
          'round-inbox-1',

        gameId:
          'game-inbox-1',

        type:
          'BET',

        amount:
          '25.00',

        currency:
          'BRL',
      };
    }

    test(
      'persists inbox, wager, ledger and outbox in the same successful processing',
      async () => {
        const playerId =
          'player-inbox-success';

        const walletId =
          await createWallet(
            playerId,
          );

        const input =
          createInput(
            walletId,
            playerId,
          );

        const service =
          new ProcessWagerService(
            orm.em.fork(),
          );

        await service.execute(
          input,
          {
            inbox: {
              consumerName:
                'wager-transactions-consumer',

              messageId:
                'message-inbox-success',

              payloadHash:
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        );

        const verificationEm =
          orm.em.fork();

        const inbox =
          await verificationEm.findOneOrFail(
            InboxMessageEntity,
            {
              consumerName:
                'wager-transactions-consumer',

              messageId:
                'message-inbox-success',
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

        const wagers =
          await verificationEm.find(
            WagerTransactionEntity,
            {
              transactionId:
                'internal-inbox-bet-1',
            },
          );

        const ledger =
          await verificationEm.find(
            LedgerEntryEntity,
            {
              transactionId:
                'internal-inbox-bet-1',
            },
          );

        const outbox =
          await verificationEm.find(
            OutboxEventEntity,
            {},
          );

        expect(
          inbox.processedAt,
        ).not.toBeNull();

        expect(
          wallet.balance,
        ).toBe(
          '75.00',
        );

        expect(
          wagers,
        ).toHaveLength(
          1,
        );

        expect(
          ledger,
        ).toHaveLength(
          1,
        );

        expect(
          outbox,
        ).toHaveLength(
          2,
        );
      },
    );

    test(
      'does not process the same inbox message twice',
      async () => {
        const playerId =
          'player-inbox-duplicate';

        const walletId =
          await createWallet(
            playerId,
          );

        const input =
          createInput(
            walletId,
            playerId,
          );

        const context = {
          inbox: {
            consumerName:
              'wager-transactions-consumer',

            messageId:
              'message-inbox-duplicate',

            payloadHash:
              'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        };

        await new ProcessWagerService(
          orm.em.fork(),
        ).execute(
          input,
          context,
        );

        await new ProcessWagerService(
          orm.em.fork(),
        ).execute(
          input,
          context,
        );

        const verificationEm =
          orm.em.fork();

        const wallet =
          await verificationEm.findOneOrFail(
            WalletEntity,
            {
              id:
                walletId,
            },
          );

        const inboxMessages =
          await verificationEm.find(
            InboxMessageEntity,
            {
              consumerName:
                'wager-transactions-consumer',

              messageId:
                'message-inbox-duplicate',
            },
          );

        const wagers =
          await verificationEm.find(
            WagerTransactionEntity,
            {
              transactionId:
                'internal-inbox-bet-1',
            },
          );

        const ledger =
          await verificationEm.find(
            LedgerEntryEntity,
            {
              transactionId:
                'internal-inbox-bet-1',
            },
          );

        expect(
          wallet.balance,
        ).toBe(
          '75.00',
        );

        expect(
          inboxMessages,
        ).toHaveLength(
          1,
        );

        expect(
          wagers,
        ).toHaveLength(
          1,
        );

        expect(
          ledger,
        ).toHaveLength(
          1,
        );
      },
    );

    test(
      'rejects same inbox message id with different payload hash',
      async () => {
        const playerId =
          'player-inbox-conflict';

        const walletId =
          await createWallet(
            playerId,
          );

        const input =
          createInput(
            walletId,
            playerId,
          );

        await new ProcessWagerService(
          orm.em.fork(),
        ).execute(
          input,
          {
            inbox: {
              consumerName:
                'wager-transactions-consumer',

              messageId:
                'message-inbox-conflict',

              payloadHash:
                'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            },
          },
        );

        await expect(
          new ProcessWagerService(
            orm.em.fork(),
          ).execute(
            input,
            {
              inbox: {
                consumerName:
                  'wager-transactions-consumer',

                messageId:
                  'message-inbox-conflict',

                payloadHash:
                  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
              },
            },
          ),
        ).rejects.toThrow(
          'INBOX_MESSAGE_CONFLICT',
        );

        const verificationEm =
          orm.em.fork();

        const wallet =
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
      },
    );

    test(
      'rolls back inbox when financial processing fails before commit',
      async () => {
        const playerId =
          'player-inbox-rollback';

        const missingWalletId =
          randomUUID();

        const input =
          createInput(
            missingWalletId,
            playerId,
          );

        await expect(
          new ProcessWagerService(
            orm.em.fork(),
          ).execute(
            input,
            {
              inbox: {
                consumerName:
                  'wager-transactions-consumer',

                messageId:
                  'message-inbox-rollback',

                payloadHash:
                  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
              },
            },
          ),
        ).rejects.toThrow();

        const verificationEm =
          orm.em.fork();

        const inbox =
          await verificationEm.find(
            InboxMessageEntity,
            {
              consumerName:
                'wager-transactions-consumer',

              messageId:
                'message-inbox-rollback',
            },
          );

        const wagers =
          await verificationEm.find(
            WagerTransactionEntity,
            {
              transactionId:
                'internal-inbox-bet-1',
            },
          );

        const ledger =
          await verificationEm.find(
            LedgerEntryEntity,
            {
              transactionId:
                'internal-inbox-bet-1',
            },
          );

        expect(
          inbox,
        ).toHaveLength(
          0,
        );

        expect(
          wagers,
        ).toHaveLength(
          0,
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