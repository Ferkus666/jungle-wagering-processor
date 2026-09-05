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
  'Reconciliation HTTP - integration',
  () => {
    let app:
      INestApplication;

    let orm:
      MikroORM;

    beforeAll(
      async () => {
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
      },
    );

    beforeEach(
      async () => {
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
      },
    );

    afterAll(
      async () => {
        await app.close();
      },
    );

    test(
      'reconstructs wallet balance from ledger exactly',
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

        expect(
          wallet.status,
        ).toBe(
          201,
        );

        const bet =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              `reconcile-bet-${randomUUID()}`,
            )
            .send({
              providerId:
                'provider-reconciliation',

              externalTransactionId:
                `bet-${randomUUID()}`,

              playerId:
                wallet.body.playerId,

              walletId:
                wallet.body.id,

              roundId:
                'round-reconciliation-bet',

              gameId:
                'game-reconciliation',

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
          bet.status,
        ).toBe(
          200,
        );

        const win =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              `reconcile-win-${randomUUID()}`,
            )
            .send({
              providerId:
                'provider-reconciliation',

              externalTransactionId:
                `win-${randomUUID()}`,

              playerId:
                wallet.body.playerId,

              walletId:
                wallet.body.id,

              roundId:
                'round-reconciliation-win',

              gameId:
                'game-reconciliation',

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
          win.status,
        ).toBe(
          200,
        );

        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              `/wallets/${wallet.body.id}/reconciliation`,
            );

        expect(
          response.status,
        ).toBe(
          200,
        );

        expect(
          response.body.storedBalance,
        ).toBe(
          '85.00',
        );

        expect(
          response.body.reconstructedBalance,
        ).toBe(
          '85.00',
        );

        expect(
          response.body.consistent,
        ).toBe(
          true,
        );

        expect(
          response.body.ledgerEntries,
        ).toBe(
          3,
        );
      },
    );

    test(
      'detects divergence between stored balance and reconstructed ledger',
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

        expect(
          wallet.status,
        ).toBe(
          201,
        );

        const em =
          orm.em.fork();

        await em.nativeUpdate(
          WalletEntity,
          {
            id:
              wallet.body.id,
          },
          {
            balance:
              '99.00',
          },
        );

        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              `/wallets/${wallet.body.id}/reconciliation`,
            );

        expect(
          response.status,
        ).toBe(
          200,
        );

        expect(
          response.body.storedBalance,
        ).toBe(
          '99.00',
        );

        expect(
          response.body.reconstructedBalance,
        ).toBe(
          '100.00',
        );

        expect(
          response.body.consistent,
        ).toBe(
          false,
        );
      },
    );

    test(
      'returns 404 when reconciling unknown wallet',
      async () => {
        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              `/wallets/${randomUUID()}/reconciliation`,
            );

        expect(
          response.status,
        ).toBe(
          404,
        );
      },
    );

    test(
      'keeps legacy GET reconciliation route as compatibility alias',
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

        expect(
          wallet.status,
        ).toBe(
          201,
        );

        const response =
          await request(
            app.getHttpServer(),
          )
            .get(
              `/reconciliation/wallets/${wallet.body.id}`,
            );

        expect(
          response.status,
        ).toBe(
          200,
        );

        expect(
          response.body.consistent,
        ).toBe(
          true,
        );
      },
    );

  },
);
