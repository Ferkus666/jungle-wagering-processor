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

import { AppModule } from '../../src/app.module.js';

import { WalletEntity } from '../../src/domain/wallet/wallet.entity.js';
import { LedgerEntryEntity } from '../../src/domain/ledger/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../src/domain/wager/wager-transaction.entity.js';
import { IdempotencyRecordEntity } from '../../src/domain/idempotency/idempotency-record.entity.js';

import { InboxMessageEntity } from '../../src/infrastructure/inbox/inbox-message.entity.js';
import { OutboxEventEntity } from '../../src/infrastructure/outbox/outbox-event.entity.js';

import { randomUUID } from 'node:crypto';

describe(
  'Wager HTTP - integration',
  () => {
    let app: INestApplication;
    let orm: MikroORM;

    beforeAll(async () => {
      const moduleRef =
        await Test.createTestingModule({
          imports: [
            AppModule,
          ],
        }).compile();

      app =
        moduleRef.createNestApplication();

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

    async function createWallet(
      balance = '100.00',
    ): Promise<{
      walletId: string;
      playerId: string;
    }> {
      const em =
        orm.em.fork();

      const walletId =
        randomUUID();

      const playerId =
        `player-${randomUUID()}`;

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

      return {
        walletId,
        playerId,
      };
    }

    test(
      'processes BET through HTTP',
      async () => {
        const {
          walletId,
          playerId,
        } =
          await createWallet();

        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              'http-bet-1',
            )
            .send({
              providerId:
                'provider-http',

              externalTransactionId:
                'external-bet-http-1',

              playerId,

              walletId,

              roundId:
                'round-http-1',

              gameId:
                'game-http-1',

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
          response.status,
        ).toBe(
          200,
        );

        expect(
          response.body.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          response.body.balance,
        ).toEqual({
          amount:
            '75.00',

          currency:
            'BRL',
        });

        expect(
          response.body.idempotentReplay,
        ).toBe(
          false,
        );

        expect(
          typeof response.body
            .transactionId,
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
                walletId,
            },
          );

        const ledger =
          await em.find(
            LedgerEntryEntity,
            {
              walletId,
            },
          );

        expect(
          wallet.balance,
        ).toBe(
          '75.00',
        );

        expect(
          ledger,
        ).toHaveLength(
          1,
        );

        expect(
          ledger[0]?.amount,
        ).toBe(
          '25.00',
        );
      },
    );

    test(
      'returns replay for identical Idempotency-Key',
      async () => {
        const {
          walletId,
          playerId,
        } =
          await createWallet();

        const body = {
          providerId:
            'provider-http',

          externalTransactionId:
            'external-idempotent-http',

          playerId,

          walletId,

          roundId:
            'round-http-idempotent',

          gameId:
            'game-http-idempotent',

          kind:
            'BET',

          money: {
            amount:
              '20.00',

            currency:
              'BRL',
          },
        };

        const first =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              'same-http-key',
            )
            .send(
              body,
            );

        const second =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              'same-http-key',
            )
            .send(
              body,
            );

        expect(
          first.status,
        ).toBe(
          200,
        );

        expect(
          second.status,
        ).toBe(
          200,
        );

        expect(
          first.body.transactionId,
        ).toBe(
          second.body.transactionId,
        );

        expect(
          first.body.idempotentReplay,
        ).toBe(
          false,
        );

        expect(
          second.body.idempotentReplay,
        ).toBe(
          true,
        );

        const em =
          orm.em.fork();

        const wallet =
          await em.findOneOrFail(
            WalletEntity,
            {
              id:
                walletId,
            },
          );

        const ledger =
          await em.find(
            LedgerEntryEntity,
            {
              walletId,
            },
          );

        expect(
          wallet.balance,
        ).toBe(
          '80.00',
        );

        expect(
          ledger,
        ).toHaveLength(
          1,
        );
      },
    );

    test(
      'returns conflict when same Idempotency-Key is reused with different payload',
      async () => {
        const {
          walletId,
          playerId,
        } =
          await createWallet();

        const baseBody = {
          providerId:
            'provider-http',

          externalTransactionId:
            'external-conflict-http',

          playerId,

          walletId,

          roundId:
            'round-conflict',

          gameId:
            'game-conflict',

          kind:
            'BET',

          money: {
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
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              'http-conflict-key',
            )
            .send(
              baseBody,
            );

        const second =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              'http-conflict-key',
            )
            .send({
              ...baseBody,

              externalTransactionId:
                'external-conflict-http-2',

              money: {
                amount:
                  '15.00',

                currency:
                  'BRL',
              },
            });

        expect(
          first.status,
        ).toBe(
          200,
        );

        expect(
          second.status,
        ).toBe(
          409,
        );
      },
    );

    test(
      'requires Idempotency-Key header',
      async () => {
        const {
          walletId,
          playerId,
        } =
          await createWallet();

        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .send({
              providerId:
                'provider-http',

              externalTransactionId:
                'external-no-header',

              playerId,

              walletId,

              roundId:
                'round-no-header',

              gameId:
                'game-no-header',

              kind:
                'BET',

              money: {
                amount:
                  '10.00',

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
      'rejects monetary JSON number',
      async () => {
        const {
          walletId,
          playerId,
        } =
          await createWallet();

        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              'invalid-money-http',
            )
            .send({
              providerId:
                'provider-http',

              externalTransactionId:
                'external-invalid-money',

              playerId,

              walletId,

              roundId:
                'round-invalid-money',

              gameId:
                'game-invalid-money',

              kind:
                'BET',

              money: {
                amount:
                  10.5,

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
      'returns original observed balance on idempotent replay after later wallet changes',
      async () => {
        const {
          walletId,
          playerId,
        } =
          await createWallet();

        const betBody = {
          providerId:
            'provider-http',

          externalTransactionId:
            'external-original-balance-bet',

          playerId,

          walletId,

          roundId:
            'round-original-balance',

          gameId:
            'game-original-balance',

          kind:
            'BET',

          money: {
            amount:
              '20.00',

            currency:
              'BRL',
          },
        };

        const firstBet =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              'original-balance-bet-key',
            )
            .send(
              betBody,
            );

        expect(
          firstBet.status,
        ).toBe(
          200,
        );

        expect(
          firstBet.body.balance,
        ).toEqual({
          amount:
            '80.00',

          currency:
            'BRL',
        });

        expect(
          firstBet.body.idempotentReplay,
        ).toBe(
          false,
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
              'later-win-key',
            )
            .send({
              providerId:
                'provider-http',

              externalTransactionId:
                'external-later-win',

              playerId,

              walletId,

              roundId:
                'round-later-win',

              gameId:
                'game-later-win',

              kind:
                'WIN',

              money: {
                amount:
                  '50.00',

                currency:
                  'BRL',
              },
            });

        expect(
          win.status,
        ).toBe(
          200,
        );

        expect(
          win.body.balance,
        ).toEqual({
          amount:
            '130.00',

          currency:
            'BRL',
        });

        const replay =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              'original-balance-bet-key',
            )
            .send(
              betBody,
            );

        expect(
          replay.status,
        ).toBe(
          200,
        );

        expect(
          replay.body.transactionId,
        ).toBe(
          firstBet.body.transactionId,
        );

        expect(
          replay.body.idempotentReplay,
        ).toBe(
          true,
        );

        expect(
          replay.body.balance,
        ).toEqual({
          amount:
            '80.00',

          currency:
            'BRL',
        });

        const em =
          orm.em.fork();

        const wallet =
          await em.findOneOrFail(
            WalletEntity,
            {
              id:
                walletId,
            },
          );

        const ledger =
          await em.find(
            LedgerEntryEntity,
            {
              walletId,
            },
          );

        expect(
          wallet.balance,
        ).toBe(
          '130.00',
        );

        expect(
          ledger,
        ).toHaveLength(
          2,
        );
      },
    );

    test(
      'accepts referenceExternalTransactionId for REFUND',
      async () => {
        const {
          walletId,
          playerId,
        } =
          await createWallet();

        const bet =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              'http-original-bet',
            )
            .send({
              providerId:
                'provider-http',

              externalTransactionId:
                'http-bet-reference',

              playerId,

              walletId,

              roundId:
                'round-http-refund',

              gameId:
                'game-http-refund',

              kind:
                'BET',

              money: {
                amount:
                  '30.00',

                currency:
                  'BRL',
              },
            });

        expect(
          bet.status,
        ).toBe(
          200,
        );

        const refund =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              'http-refund',
            )
            .send({
              providerId:
                'provider-http',

              externalTransactionId:
                'http-refund-reference',

              referenceExternalTransactionId:
                'http-bet-reference',

              playerId,

              walletId,

              roundId:
                'round-http-refund',

              gameId:
                'game-http-refund',

              kind:
                'REFUND',

              money: {
                amount:
                  '30.00',

                currency:
                  'BRL',
              },
            });

        expect(
          refund.status,
        ).toBe(
          200,
        );

        expect(
          refund.body.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          refund.body.balance,
        ).toEqual({
          amount:
            '100.00',

          currency:
            'BRL',
        });
      },
    );

    test(
      'returns 422 for business rejection caused by insufficient funds',
      async () => {
        const {
          walletId,
          playerId,
        } =
          await createWallet();

        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              `insufficient-${randomUUID()}`,
            )
            .send({
              providerId:
                'provider-http',

              externalTransactionId:
                `insufficient-${randomUUID()}`,

              playerId,

              walletId,

              roundId:
                'round-insufficient',

              gameId:
                'game-insufficient',

              kind:
                'BET',

              money: {
                amount:
                  '150.00',

                currency:
                  'BRL',
              },
            });

        expect(
          response.status,
        ).toBe(
          422,
        );

        expect(
          response.body.status,
        ).toBe(
          'REJECTED',
        );

        expect(
          response.body.failureCode,
        ).toBe(
          'INSUFFICIENT_FUNDS',
        );

        expect(
          response.body.balance,
        ).toEqual({
          amount:
            '100.00',

          currency:
            'BRL',
        });

        const em =
          orm.em.fork();

        const ledger =
          await em.find(
            LedgerEntryEntity,
            {
              walletId,
            },
          );

        expect(
          ledger,
        ).toHaveLength(
          0,
        );
      },
    );

    test(
      'returns 202 when reversal is pending because reference has not arrived yet',
      async () => {
        const {
          walletId,
          playerId,
        } =
          await createWallet();

        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              '/wagering/transactions',
            )
            .set(
              'Idempotency-Key',
              `pending-reference-${randomUUID()}`,
            )
            .send({
              providerId:
                'provider-http',

              externalTransactionId:
                `refund-${randomUUID()}`,

              playerId,

              walletId,

              roundId:
                'round-pending-reference',

              gameId:
                'game-pending-reference',

              kind:
                'REFUND',

              money: {
                amount:
                  '25.00',

                currency:
                  'BRL',
              },

              referenceExternalTransactionId:
                'bet-that-has-not-arrived',
            });

        expect(
          response.status,
        ).toBe(
          202,
        );

        expect(
          response.body.status,
        ).toBe(
          'PENDING_REFERENCE',
        );

        expect(
          response.body.balance,
        ).toEqual({
          amount:
            '100.00',

          currency:
            'BRL',
        });

        const em =
          orm.em.fork();

        const transaction =
          await em.findOneOrFail(
            WagerTransactionEntity,
            {
              transactionId:
                response.body.transactionId,
            },
          );

        expect(
          transaction.status,
        ).toBe(
          'PENDING_REFERENCE',
        );

        const ledger =
          await em.find(
            LedgerEntryEntity,
            {
              walletId,
            },
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