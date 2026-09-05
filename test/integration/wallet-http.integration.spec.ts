import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  INestApplication,
} from '@nestjs/common';

import {
  Test,
} from '@nestjs/testing';

import {
  MikroORM,
} from '@mikro-orm/core';

import request from 'supertest';

import {
  AppModule,
} from '../../src/app.module.js';

import {
  WalletEntity,
} from '../../src/domain/wallet/wallet.entity.js';

import {
  LedgerEntryEntity,
} from '../../src/domain/ledger/ledger-entry.entity.js';

import {
  WagerTransactionEntity,
} from '../../src/domain/wager/wager-transaction.entity.js';

import {
  IdempotencyRecordEntity,
} from '../../src/domain/idempotency/idempotency-record.entity.js';

import {
  InboxMessageEntity,
} from '../../src/infrastructure/inbox/inbox-message.entity.js';

import {
  OutboxEventEntity,
} from '../../src/infrastructure/outbox/outbox-event.entity.js';

import {
  randomUUID,
} from 'node:crypto';

describe(
  'Wallet HTTP - integration',
  () => {
    let app: INestApplication;
    let orm: MikroORM;

    beforeAll(async () => {
      const moduleRef =
        await Test
          .createTestingModule({
            imports: [
              AppModule,
            ],
          })
          .compile();

      app =
        moduleRef
          .createNestApplication();

      await app.init();

      orm =
        moduleRef.get(
          MikroORM,
        );
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
      await app.close();
    });

    test(
      'creates wallet with OPENING transaction and CREDIT ledger',
      async () => {
        const playerId =
          `player-${randomUUID()}`;

        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wallets',
            )
            .send({
              playerId,

              initialBalance: {
                amount:
                  '100.00',

                currency:
                  'BRL',
              },
            });

        expect(
          response.status,
        ).toBe(
          201,
        );

        expect(
          response.body.playerId,
        ).toBe(
          playerId,
        );

        expect(
          response.body.balance,
        ).toEqual({
          amount:
            '100.00',

          currency:
            'BRL',
        });

        expect(
          response.body.version,
        ).toBe(
          1,
        );

        expect(
          typeof response.body.id,
        ).toBe(
          'string',
        );

        const em =
          orm.em.fork();

        const wallet =
          await em.findOneOrFail(
            WalletEntity,
            {
              id:
                response.body.id,
            },
          );

        const transactions =
          await em.find(
            WagerTransactionEntity,
            {
              walletId:
                wallet.id,
            },
          );

        const ledger =
          await em.find(
            LedgerEntryEntity,
            {
              walletId:
                wallet.id,
            },
          );

        const outbox =
          await em.find(
            OutboxEventEntity,
            {
              aggregateId:
                wallet.id,
            },
          );

        expect(
          wallet.balance,
        ).toBe(
          '100.00',
        );

        expect(
          wallet.version,
        ).toBe(
          1,
        );

        expect(
          transactions,
        ).toHaveLength(
          1,
        );

        expect(
          transactions[0]?.type,
        ).toBe(
          'OPENING',
        );

        expect(
          transactions[0]?.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          transactions[0]?.amount,
        ).toBe(
          '100.00',
        );

        expect(
          ledger,
        ).toHaveLength(
          1,
        );

        expect(
          ledger[0]?.entryType,
        ).toBe(
          'OPENING',
        );

        expect(
          ledger[0]?.amount,
        ).toBe(
          '100.00',
        );

        expect(
          outbox,
        ).toHaveLength(
          1,
        );

        expect(
          outbox[0]?.eventType,
        ).toBe(
          'WalletBalanceChanged.v1',
        );
      },
    );

    test(
      'creates zero-balance wallet without OPENING ledger',
      async () => {
        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wallets',
            )
            .send({
              playerId:
                `player-${randomUUID()}`,

              initialBalance: {
                amount:
                  '0.00',

                currency:
                  'BRL',
              },
            });

        expect(
          response.status,
        ).toBe(
          201,
        );

        expect(
          response.body.balance.amount,
        ).toBe(
          '0.00',
        );

        expect(
          response.body.version,
        ).toBe(
          1,
        );

        const em =
          orm.em.fork();

        const transactions =
          await em.find(
            WagerTransactionEntity,
            {
              walletId:
                response.body.id,
            },
          );

        const ledger =
          await em.find(
            LedgerEntryEntity,
            {
              walletId:
                response.body.id,
            },
          );

        expect(
          transactions,
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

    test(
      'rejects duplicate player and currency wallet',
      async () => {
        const playerId =
          `player-${randomUUID()}`;

        const body = {
          playerId,

          initialBalance: {
            amount:
              '10.00',

            currency:
              'BRL',
          },
        };

        const first =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wallets',
            )
            .send(
              body,
            );

        expect(
          first.status,
        ).toBe(
          201,
        );

        const duplicate =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wallets',
            )
            .send(
              body,
            );

        expect(
          duplicate.status,
        ).toBe(
          409,
        );
      },
    );

    test(
      'rejects monetary JSON number',
      async () => {
        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wallets',
            )
            .send({
              playerId:
                `player-${randomUUID()}`,

              initialBalance: {
                amount:
                  100,

                currency:
                  'BRL',
              },
            });

        expect(
          response.status,
        ).toBe(
          400,
        );
      },
    );

    test(
      'gets wallet by id with balance and version',
      async () => {
        const created =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wallets',
            )
            .send({
              playerId:
                `player-${randomUUID()}`,

              initialBalance: {
                amount:
                  '100.00',

                currency:
                  'BRL',
              },
            });

        expect(
          created.status,
        ).toBe(
          201,
        );

        const response =
          await request(
            app.getHttpServer(),
          )
            .get(
              `/wallets/${created.body.id}`,
            );

        expect(
          response.status,
        ).toBe(
          200,
        );

        expect(
          response.body,
        ).toEqual({
          id:
            created.body.id,

          playerId:
            created.body.playerId,

          balance: {
            amount:
              '100.00',

            currency:
              'BRL',
          },

          version:
            1,
        });
      },
    );

    test(
      'returns 404 when wallet does not exist',
      async () => {
        const response =
          await request(
            app.getHttpServer(),
          )
            .get(
              `/wallets/${randomUUID()}`,
            );

        expect(
          response.status,
        ).toBe(
          404,
        );
      },
    );

    test(
      'returns wallet ledger using stable opaque cursor pagination',
      async () => {
        const created =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wallets',
            )
            .send({
              playerId:
                `player-${randomUUID()}`,

              initialBalance: {
                amount:
                  '100.00',

                currency:
                  'BRL',
              },
            });

        expect(
          created.status,
        ).toBe(
          201,
        );

        const firstTransaction =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              `ledger-bet-${randomUUID()}`,
            )
            .send({
              providerId:
                'provider-ledger',

              externalTransactionId:
                `bet-${randomUUID()}`,

              playerId:
                created.body.playerId,

              walletId:
                created.body.id,

              roundId:
                'round-ledger-1',

              gameId:
                'game-ledger',

              kind:
                'BET',

              money: {
                amount:
                  '20.00',

                currency:
                  'BRL',
              },
            });

        expect(
          firstTransaction.status,
        ).toBe(
          200,
        );

        const secondTransaction =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              `ledger-win-${randomUUID()}`,
            )
            .send({
              providerId:
                'provider-ledger',

              externalTransactionId:
                `win-${randomUUID()}`,

              playerId:
                created.body.playerId,

              walletId:
                created.body.id,

              roundId:
                'round-ledger-2',

              gameId:
                'game-ledger',

              kind:
                'WIN',

              money: {
                amount:
                  '10.00',

                currency:
                  'BRL',
              },
            });

        expect(
          secondTransaction.status,
        ).toBe(
          200,
        );

        const firstPage =
          await request(
            app.getHttpServer(),
          )
            .get(
              `/wallets/${created.body.id}/ledger?limit=2`,
            );

        expect(
          firstPage.status,
        ).toBe(
          200,
        );

        expect(
          firstPage.body.items,
        ).toHaveLength(
          2,
        );

        expect(
          typeof firstPage.body.nextCursor,
        ).toBe(
          'string',
        );

        const secondPage =
          await request(
            app.getHttpServer(),
          )
            .get(
              `/wallets/${created.body.id}/ledger`,
            )
            .query({
              limit:
                2,

              cursor:
                firstPage.body.nextCursor,
            });

        expect(
          secondPage.status,
        ).toBe(
          200,
        );

        expect(
          secondPage.body.items,
        ).toHaveLength(
          1,
        );

        expect(
          secondPage.body.nextCursor,
        ).toBeNull();

        const allIds = [
          ...firstPage.body.items,
          ...secondPage.body.items,
        ].map(
          (entry: {
            id: string;
          }) =>
            entry.id,
        );

        expect(
          new Set(
            allIds,
          ).size,
        ).toBe(
          3,
        );
      },
    );

    test(
      'rejects invalid ledger cursor',
      async () => {
        const created =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wallets',
            )
            .send({
              playerId:
                `player-${randomUUID()}`,

              initialBalance: {
                amount:
                  '10.00',

                currency:
                  'BRL',
              },
            });

        const response =
          await request(
            app.getHttpServer(),
          )
            .get(
              `/wallets/${created.body.id}/ledger`,
            )
            .query({
              cursor:
                'not-a-valid-cursor',
            });

        expect(
          response.status,
        ).toBe(
          400,
        );
      },
    );
  },
);
