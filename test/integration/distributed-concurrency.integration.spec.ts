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

import {
  randomUUID,
} from 'node:crypto';

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
  OutboxEventEntity,
} from '../../src/infrastructure/outbox/outbox-event.entity.js';

import {
  ProcessWagerService,
} from '../../src/application/wager/process-wager.service.js';

import type {
  ProcessWagerInput,
} from '../../src/application/wager/process-wager.input.js';

describe(
  'Distributed concurrency - integration',
  () => {
    let orm1:
      MikroORM<PostgreSqlDriver>;

    let orm2:
      MikroORM<PostgreSqlDriver>;

    let orm3:
      MikroORM<PostgreSqlDriver>;

    const ormConfig = {
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
    };

    beforeAll(
      async () => {
        /*
         * Três conexões ORM totalmente
         * independentes representam três
         * instâncias da aplicação acessando
         * o mesmo PostgreSQL.
         */
        [
          orm1,
          orm2,
          orm3,
        ] =
          await Promise.all([
            MikroORM.init<PostgreSqlDriver>(
              ormConfig,
            ),

            MikroORM.init<PostgreSqlDriver>(
              ormConfig,
            ),

            MikroORM.init<PostgreSqlDriver>(
              ormConfig,
            ),
          ]);
      },
    );

    beforeEach(
      async () => {
        const em =
          orm1.em.fork();

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
      },
    );

    afterAll(
      async () => {
        await Promise.all([
          orm1.close(true),
          orm2.close(true),
          orm3.close(true),
        ]);
      },
    );

    async function createWallet(
      playerId: string,
      balance:
        string =
          '100.00',
    ): Promise<string> {
      const em =
        orm1.em.fork();

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

            version:
              1,

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
      overrides:
        Partial<
          ProcessWagerInput
        >,
    ): ProcessWagerInput {
      return {
        idempotencyKey:
          `key-${randomUUID()}`,

        transactionId:
          randomUUID(),

        providerId:
          'provider-distributed',

        externalTransactionId:
          `external-${randomUUID()}`,

        playerId:
          'player-default',

        walletId:
          randomUUID(),

        roundId:
          `round-${randomUUID()}`,

        gameId:
          'game-distributed',

        type:
          'BET',

        amount:
          '10.00',

        currency:
          'BRL',

        ...overrides,
      };
    }

    test(
      'processes the same BET only once across three independent application instances',
      async () => {
        const playerId =
          `player-${randomUUID()}`;

        const walletId =
          await createWallet(
            playerId,
            '100.00',
          );

        const input =
          createInput({
            idempotencyKey:
              `provider-distributed:bet-${randomUUID()}`,

            transactionId:
              randomUUID(),

            externalTransactionId:
              `bet-${randomUUID()}`,

            playerId,

            walletId,

            roundId:
              'round-three-instances',

            amount:
              '30.00',
          });

        const services = [
          new ProcessWagerService(
            orm1.em.fork(),
          ),

          new ProcessWagerService(
            orm2.em.fork(),
          ),

          new ProcessWagerService(
            orm3.em.fork(),
          ),
        ];

        await Promise.all(
          Array.from(
            {
              length:
                50,
            },
            (
              _,
              index,
            ) =>
              services[
                index %
                  services.length
              ]!.execute(
                input,
              ),
          ),
        );

        const em =
          orm1.em.fork();

        const wallet =
          await em.findOneOrFail(
            WalletEntity,
            {
              id:
                walletId,
            },
          );

        const transactions =
          await em.find(
            WagerTransactionEntity,
            {
              providerId:
                input.providerId,

              externalTransactionId:
                input.externalTransactionId,
            },
          );

        const ledger =
          await em.find(
            LedgerEntryEntity,
            {
              transactionId:
                input.transactionId,
            },
          );

        const idempotency =
          await em.find(
            IdempotencyRecordEntity,
            {
              idempotencyKey:
                input.idempotencyKey,
            },
          );

        expect(
          wallet.balance,
        ).toBe(
          '70.00',
        );

        expect(
          wallet.version,
        ).toBe(
          2,
        );

        expect(
          transactions,
        ).toHaveLength(
          1,
        );

        expect(
          transactions[0]
            ?.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          ledger,
        ).toHaveLength(
          1,
        );

        expect(
          ledger[0]
            ?.amount,
        ).toBe(
          '30.00',
        );

        expect(
          idempotency,
        ).toHaveLength(
          1,
        );
      },
      20000,
    );

    test(
      'keeps competing BETs correct across separate instances without negative balance',
      async () => {
        const playerId =
          `player-${randomUUID()}`;

        const walletId =
          await createWallet(
            playerId,
            '100.00',
          );

        const first =
          createInput({
            idempotencyKey:
              `first-${randomUUID()}`,

            transactionId:
              randomUUID(),

            externalTransactionId:
              `first-${randomUUID()}`,

            playerId,

            walletId,

            roundId:
              'round-competing-three',

            amount:
              '80.00',
          });

        const second =
          createInput({
            idempotencyKey:
              `second-${randomUUID()}`,

            transactionId:
              randomUUID(),

            externalTransactionId:
              `second-${randomUUID()}`,

            playerId,

            walletId,

            roundId:
              'round-competing-three',

            amount:
              '80.00',
          });

        const [
          firstResult,
          secondResult,
        ] =
          await Promise.all([
            new ProcessWagerService(
              orm1.em.fork(),
            ).execute(
              first,
            ),

            new ProcessWagerService(
              orm2.em.fork(),
            ).execute(
              second,
            ),
          ]);

        const statuses = [
          firstResult?.status,
          secondResult?.status,
        ].sort();

        expect(
          statuses,
        ).toEqual([
          'PROCESSED',
          'REJECTED',
        ]);

        const em =
          orm3.em.fork();

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
          '20.00',
        );

        expect(
          wallet.version,
        ).toBe(
          2,
        );

        expect(
          ledger,
        ).toHaveLength(
          1,
        );

        expect(
          ledger[0]
            ?.amount,
        ).toBe(
          '80.00',
        );
      },
    );

    test(
      'processes different wallets concurrently across independent instances',
      async () => {
        const players = [
          `player-a-${randomUUID()}`,
          `player-b-${randomUUID()}`,
          `player-c-${randomUUID()}`,
        ];

        const walletIds =
          await Promise.all(
            players.map(
              (
                playerId,
              ) =>
                createWallet(
                  playerId,
                  '100.00',
                ),
            ),
          );

        const inputs =
          walletIds.map(
            (
              walletId,
              index,
            ) =>
              createInput({
                idempotencyKey:
                  `distinct-${index}-${randomUUID()}`,

                transactionId:
                  randomUUID(),

                externalTransactionId:
                  `distinct-${index}-${randomUUID()}`,

                playerId:
                  players[index]!,

                walletId,

                roundId:
                  `round-distinct-${index}`,

                amount:
                  '25.00',
              }),
          );

        const services = [
          new ProcessWagerService(
            orm1.em.fork(),
          ),

          new ProcessWagerService(
            orm2.em.fork(),
          ),

          new ProcessWagerService(
            orm3.em.fork(),
          ),
        ];

        const results =
          await Promise.all(
            inputs.map(
              (
                input,
                index,
              ) =>
                services[index]!
                  .execute(
                    input,
                  ),
            ),
          );

        expect(
          results.map(
            (
              result,
            ) =>
              result?.status,
          ),
        ).toEqual([
          'PROCESSED',
          'PROCESSED',
          'PROCESSED',
        ]);

        const em =
          orm1.em.fork();

        for (
          const walletId
          of walletIds
        ) {
          const wallet =
            await em.findOneOrFail(
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

          expect(
            wallet.version,
          ).toBe(
            2,
          );
        }

        const ledger =
          await em.find(
            LedgerEntryEntity,
            {},
          );

        expect(
          ledger,
        ).toHaveLength(
          3,
        );
      },
    );
  },
);
