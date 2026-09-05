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
  'Wager query HTTP - integration',
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
      'gets transaction by internal transaction id',
      async () => {
        const wallet =
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

        const externalTransactionId =
          `bet-${randomUUID()}`;

        const wager =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              `key-${randomUUID()}`,
            )
            .send({
              providerId:
                'provider-query',

              externalTransactionId,

              playerId:
                wallet.body.playerId,

              walletId:
                wallet.body.id,

              roundId:
                'round-query',

              gameId:
                'game-query',

              kind:
                'BET',

              money: {
                amount:
                  '25.00',

                currency:
                  'BRL',
              },
            });

        expect(
          wager.status,
        ).toBe(
          200,
        );

        const response =
          await request(
            app.getHttpServer(),
          )
            .get(
              `/wagering/transactions/${wager.body.transactionId}`,
            );

        expect(
          response.status,
        ).toBe(
          200,
        );

        expect(
          response.body.transactionId,
        ).toBe(
          wager.body.transactionId,
        );

        expect(
          response.body.providerId,
        ).toBe(
          'provider-query',
        );

        expect(
          response.body.externalTransactionId,
        ).toBe(
          externalTransactionId,
        );

        expect(
          response.body.kind,
        ).toBe(
          'BET',
        );

        expect(
          response.body.money,
        ).toEqual({
          amount:
            '25.00',

          currency:
            'BRL',
        });

        expect(
          response.body.status,
        ).toBe(
          'PROCESSED',
        );
      },
    );

    test(
      'gets transaction by provider and external transaction id',
      async () => {
        const wallet =
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

        const externalTransactionId =
          `win-${randomUUID()}`;

        const wager =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              `key-${randomUUID()}`,
            )
            .send({
              providerId:
                'provider-query',

              externalTransactionId,

              playerId:
                wallet.body.playerId,

              walletId:
                wallet.body.id,

              roundId:
                'round-query-2',

              gameId:
                'game-query',

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
          wager.status,
        ).toBe(
          200,
        );

        const response =
          await request(
            app.getHttpServer(),
          )
            .get(
              `/wagering/transactions/provider/provider-query/${externalTransactionId}`,
            );

        expect(
          response.status,
        ).toBe(
          200,
        );

        expect(
          response.body.transactionId,
        ).toBe(
          wager.body.transactionId,
        );

        expect(
          response.body.kind,
        ).toBe(
          'WIN',
        );
      },
    );

    test(
      'returns 404 for unknown internal transaction id',
      async () => {
        const response =
          await request(
            app.getHttpServer(),
          )
            .get(
              `/wagering/transactions/${randomUUID()}`,
            );

        expect(
          response.status,
        ).toBe(
          404,
        );
      },
    );

    test(
      'returns 404 for unknown provider transaction',
      async () => {
        const response =
          await request(
            app.getHttpServer(),
          )
            .get(
              '/wagering/transactions/provider/provider-missing/external-missing',
            );

        expect(
          response.status,
        ).toBe(
          404,
        );
      },
    );
  },
);
