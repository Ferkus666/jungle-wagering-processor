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

import { ProcessWagerService } from '../../src/application/wager/process-wager.service.js';

import type { ProcessWagerInput } from '../../src/application/wager/process-wager.input.js';

describe('ProcessWagerService - integration', () => {
  let orm: MikroORM<PostgreSqlDriver>;

  beforeAll(async () => {
    orm =
      await MikroORM.init<PostgreSqlDriver>({
        driver: PostgreSqlDriver,

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
          id: walletId,
          playerId,
          currency: 'BRL',
          balance,
          createdAt:
            new Date(),
          updatedAt:
            new Date(),
        },
      );

    em.persist(wallet);

    await em.flush();

    return walletId;
  }

  function createInput(
    overrides: Partial<ProcessWagerInput>,
  ): ProcessWagerInput {
    return {
      idempotencyKey:
        'provider-a:default',

      transactionId:
        'internal-default',

      providerId:
        'provider-a',

      externalTransactionId:
        'default-external',

      playerId:
        'player-default',

      walletId:
        randomUUID(),

      roundId:
        'round-default',

      gameId:
        'game-default',

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
    'prevents negative balance when two competing BETs run concurrently',
    async () => {
      const playerId =
        'player-competing-bets';

      const walletId =
        await createWallet(
          playerId,
          '100.00',
        );

      const service1 =
        new ProcessWagerService(
          orm.em.fork(),
        );

      const service2 =
        new ProcessWagerService(
          orm.em.fork(),
        );

      await Promise.all([
        service1.execute(
          createInput({
            idempotencyKey:
              'provider-a:bet-competing-1',

            transactionId:
              'internal-bet-competing-1',

            externalTransactionId:
              'bet-competing-1',

            playerId,
            walletId,

            roundId:
              'round-competing',

            gameId:
              'game-competing',

            type:
              'BET',

            amount:
              '80.00',
          }),
        ),

        service2.execute(
          createInput({
            idempotencyKey:
              'provider-a:bet-competing-2',

            transactionId:
              'internal-bet-competing-2',

            externalTransactionId:
              'bet-competing-2',

            playerId,
            walletId,

            roundId:
              'round-competing',

            gameId:
              'game-competing',

            type:
              'BET',

            amount:
              '80.00',
          }),
        ),
      ]);

      const verificationEm =
        orm.em.fork();

      const finalWallet =
        await verificationEm.findOneOrFail(
          WalletEntity,
          {
            id: walletId,
          },
        );

      const transactions =
        await verificationEm.find(
          WagerTransactionEntity,
          {
            playerId,
          },
        );

      const ledgerEntries =
        await verificationEm.find(
          LedgerEntryEntity,
          {
            playerId,
          },
        );

      expect(
        finalWallet.balance,
      ).toBe('20.00');

      expect(
        transactions,
      ).toHaveLength(2);

      const processed =
        transactions.filter(
          (transaction) =>
            transaction.status ===
            'PROCESSED',
        );

      const rejected =
        transactions.filter(
          (transaction) =>
            transaction.status ===
            'REJECTED',
        );

      expect(
        processed,
      ).toHaveLength(1);

      expect(
        rejected,
      ).toHaveLength(1);

      expect(
        rejected[0]
          ?.failureCode,
      ).toBe(
        'INSUFFICIENT_FUNDS',
      );

      expect(
        ledgerEntries,
      ).toHaveLength(1);

      expect(
        ledgerEntries[0]
          ?.amount,
      ).toBe('80.00');

      expect(
        ledgerEntries[0]
          ?.entryType,
      ).toBe('BET');
    },
  );

  test(
    'does not debit twice when the same idempotency key is replayed',
    async () => {
      const playerId =
        'player-replay';

      const walletId =
        await createWallet(
          playerId,
        );

      const input =
        createInput({
          idempotencyKey:
            'provider-a:bet-replay-1',

          transactionId:
            'internal-bet-replay-1',

          externalTransactionId:
            'bet-replay-1',

          playerId,
          walletId,

          roundId:
            'round-replay',

          gameId:
            'game-replay',

          type:
            'BET',

          amount:
            '40.00',
        });

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(input);

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(input);

      const verificationEm =
        orm.em.fork();

      const finalWallet =
        await verificationEm.findOneOrFail(
          WalletEntity,
          {
            id: walletId,
          },
        );

      const transactions =
        await verificationEm.find(
          WagerTransactionEntity,
          {
            providerId:
              'provider-a',

            externalTransactionId:
              'bet-replay-1',
          },
        );

      const ledgerEntries =
        await verificationEm.find(
          LedgerEntryEntity,
          {
            transactionId:
              'internal-bet-replay-1',
          },
        );

      const idempotencyRecords =
        await verificationEm.find(
          IdempotencyRecordEntity,
          {
            idempotencyKey:
              'provider-a:bet-replay-1',
          },
        );

      expect(
        finalWallet.balance,
      ).toBe('60.00');

      expect(
        transactions,
      ).toHaveLength(1);

      expect(
        ledgerEntries,
      ).toHaveLength(1);

      expect(
        ledgerEntries[0]
          ?.amount,
      ).toBe('40.00');

      expect(
        idempotencyRecords,
      ).toHaveLength(1);

      expect(
        idempotencyRecords[0]
          ?.status,
      ).toBe('COMPLETED');
    },
  );

  test(
    'processes the same BET only once when received 50 times concurrently',
    async () => {
      const playerId =
        'player-concurrent-idempotency';

      const walletId =
        await createWallet(
          playerId,
        );

      const input =
        createInput({
          idempotencyKey:
            'provider-a:bet-concurrent-50',

          transactionId:
            'internal-bet-concurrent-50',

          externalTransactionId:
            'bet-concurrent-50',

          playerId,
          walletId,

          roundId:
            'round-concurrent-50',

          gameId:
            'game-concurrent-50',

          type:
            'BET',

          amount:
            '30.00',
        });

      await Promise.all(
        Array.from(
          {
            length: 50,
          },
          async () => {
            const service =
              new ProcessWagerService(
                orm.em.fork(),
              );

            await service.execute(
              input,
            );
          },
        ),
      );

      const verificationEm =
        orm.em.fork();

      const finalWallet =
        await verificationEm.findOneOrFail(
          WalletEntity,
          {
            id: walletId,
          },
        );

      const transactions =
        await verificationEm.find(
          WagerTransactionEntity,
          {
            providerId:
              'provider-a',

            externalTransactionId:
              'bet-concurrent-50',
          },
        );

      const ledgerEntries =
        await verificationEm.find(
          LedgerEntryEntity,
          {
            transactionId:
              'internal-bet-concurrent-50',
          },
        );

      const idempotencyRecords =
        await verificationEm.find(
          IdempotencyRecordEntity,
          {
            idempotencyKey:
              'provider-a:bet-concurrent-50',
          },
        );

      expect(
        finalWallet.balance,
      ).toBe('70.00');

      expect(
        transactions,
      ).toHaveLength(1);

      expect(
        transactions[0]
          ?.status,
      ).toBe('PROCESSED');

      expect(
        ledgerEntries,
      ).toHaveLength(1);

      expect(
        ledgerEntries[0]
          ?.amount,
      ).toBe('30.00');

      expect(
        idempotencyRecords,
      ).toHaveLength(1);

      expect(
        idempotencyRecords[0]
          ?.status,
      ).toBe('COMPLETED');
    },
    20000,
  );

  test(
    'rejects reuse of the same idempotency key with a different payload',
    async () => {
      const playerId =
        'player-conflict';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:bet-conflict-1',

          transactionId:
            'internal-bet-conflict-1',

          externalTransactionId:
            'bet-conflict-1',

          playerId,
          walletId,

          roundId:
            'round-conflict',

          gameId:
            'game-conflict',

          type:
            'BET',

          amount:
            '30.00',
        }),
      );

      await expect(
        new ProcessWagerService(
          orm.em.fork(),
        ).execute(
          createInput({
            idempotencyKey:
              'provider-a:bet-conflict-1',

            transactionId:
              'internal-bet-conflict-1',

            externalTransactionId:
              'bet-conflict-1',

            playerId,
            walletId,

            roundId:
              'round-conflict',

            gameId:
              'game-conflict',

            type:
              'BET',

            amount:
              '40.00',
          }),
        ),
      ).rejects.toThrow(
        'IDEMPOTENCY_KEY_CONFLICT',
      );

      const verificationEm =
        orm.em.fork();

      const finalWallet =
        await verificationEm.findOneOrFail(
          WalletEntity,
          {
            id: walletId,
          },
        );

      expect(
        finalWallet.balance,
      ).toBe('70.00');
    },
  );

  test(
    'credits wallet and creates a positive ledger entry for WIN',
    async () => {
      const playerId =
        'player-win-1';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:win-1',

          transactionId:
            'internal-win-1',

          externalTransactionId:
            'win-1',

          playerId,
          walletId,

          roundId:
            'round-win-1',

          gameId:
            'game-win-1',

          type:
            'WIN',

          amount:
            '50.00',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const finalWallet =
        await verificationEm.findOneOrFail(
          WalletEntity,
          {
            id: walletId,
          },
        );

      const ledgerEntries =
        await verificationEm.find(
          LedgerEntryEntity,
          {
            transactionId:
              'internal-win-1',
          },
        );

      expect(
        finalWallet.balance,
      ).toBe('150.00');

      expect(
        ledgerEntries,
      ).toHaveLength(1);

      expect(
        ledgerEntries[0]
          ?.amount,
      ).toBe('50.00');
    },
  );

  test(
    'processes LOSS without changing wallet balance or creating ledger entry',
    async () => {
      const playerId =
        'player-loss-1';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:loss-1',

          transactionId:
            'internal-loss-1',

          externalTransactionId:
            'loss-1',

          playerId,
          walletId,

          roundId:
            'round-loss-1',

          gameId:
            'game-loss-1',

          type:
            'LOSS',

          amount:
            '50.00',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const finalWallet =
        await verificationEm.findOneOrFail(
          WalletEntity,
          {
            id: walletId,
          },
        );

      const ledgerEntries =
        await verificationEm.find(
          LedgerEntryEntity,
          {
            transactionId:
              'internal-loss-1',
          },
        );

      expect(
        finalWallet.balance,
      ).toBe('100.00');

      expect(
        ledgerEntries,
      ).toHaveLength(0);
    },
  );

  test(
    'refunds a processed BET and restores the wallet balance',
    async () => {
      const playerId =
        'player-refund-1';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:bet-refund-1',

          transactionId:
            'internal-bet-refund-1',

          externalTransactionId:
            'bet-refund-1',

          playerId,
          walletId,

          roundId:
            'round-refund-1',

          gameId:
            'game-refund-1',

          type:
            'BET',

          amount:
            '30.00',
        }),
      );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:refund-1',

          transactionId:
            'internal-refund-1',

          externalTransactionId:
            'refund-1',

          playerId,
          walletId,

          roundId:
            'round-refund-1',

          gameId:
            'game-refund-1',

          type:
            'REFUND',

          amount:
            '30.00',

          referenceTransactionId:
            'bet-refund-1',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const finalWallet =
        await verificationEm.findOneOrFail(
          WalletEntity,
          {
            id: walletId,
          },
        );

      const ledgerEntries =
        await verificationEm.find(
          LedgerEntryEntity,
          {
            walletId,
          },
        );

      expect(
        finalWallet.balance,
      ).toBe('100.00');

      expect(
        ledgerEntries,
      ).toHaveLength(2);
    },
  );

  test(
    'rejects a second REFUND for the same processed BET',
    async () => {
      const playerId =
        'player-double-refund';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:bet-double-refund',

          transactionId:
            'internal-bet-double-refund',

          externalTransactionId:
            'bet-double-refund',

          playerId,
          walletId,

          roundId:
            'round-double-refund',

          gameId:
            'game-double-refund',

          type:
            'BET',

          amount:
            '30.00',
        }),
      );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:refund-first',

          transactionId:
            'internal-refund-first',

          externalTransactionId:
            'refund-first',

          playerId,
          walletId,

          roundId:
            'round-double-refund',

          gameId:
            'game-double-refund',

          type:
            'REFUND',

          amount:
            '30.00',

          referenceTransactionId:
            'bet-double-refund',
        }),
      );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:refund-second',

          transactionId:
            'internal-refund-second',

          externalTransactionId:
            'refund-second',

          playerId,
          walletId,

          roundId:
            'round-double-refund',

          gameId:
            'game-double-refund',

          type:
            'REFUND',

          amount:
            '30.00',

          referenceTransactionId:
            'bet-double-refund',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const finalWallet =
        await verificationEm.findOneOrFail(
          WalletEntity,
          {
            id: walletId,
          },
        );

      const secondRefund =
        await verificationEm.findOneOrFail(
          WagerTransactionEntity,
          {
            externalTransactionId:
              'refund-second',
          },
        );

      expect(
        finalWallet.balance,
      ).toBe('100.00');

      expect(
        secondRefund.status,
      ).toBe('REJECTED');

      expect(
        secondRefund.failureCode,
      ).toBe(
        'REFERENCE_ALREADY_REFUNDED',
      );
    },
  );

  test(
    'persists REFUND as PENDING_REFERENCE when the referenced BET has not arrived yet',
    async () => {
      const playerId =
        'player-pending-refund';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:refund-before-bet',

          transactionId:
            'internal-refund-before-bet',

          externalTransactionId:
            'refund-before-bet',

          playerId,
          walletId,

          roundId:
            'round-pending-refund',

          gameId:
            'game-pending-refund',

          type:
            'REFUND',

          amount:
            '30.00',

          referenceTransactionId:
            'bet-that-does-not-exist-yet',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const refund =
        await verificationEm.findOneOrFail(
          WagerTransactionEntity,
          {
            externalTransactionId:
              'refund-before-bet',
          },
        );

      expect(
        refund.status,
      ).toBe(
        'PENDING_REFERENCE',
      );
    },
  );

  test(
    'rejects REFUND when its amount differs from the referenced BET',
    async () => {
      const playerId =
        'player-refund-amount-mismatch';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:bet-amount-mismatch',

          transactionId:
            'internal-bet-amount-mismatch',

          externalTransactionId:
            'bet-amount-mismatch',

          playerId,
          walletId,

          roundId:
            'round-amount-mismatch',

          gameId:
            'game-amount-mismatch',

          type:
            'BET',

          amount:
            '30.00',
        }),
      );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:refund-amount-mismatch',

          transactionId:
            'internal-refund-amount-mismatch',

          externalTransactionId:
            'refund-amount-mismatch',

          playerId,
          walletId,

          roundId:
            'round-amount-mismatch',

          gameId:
            'game-amount-mismatch',

          type:
            'REFUND',

          amount:
            '20.00',

          referenceTransactionId:
            'bet-amount-mismatch',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const refund =
        await verificationEm.findOneOrFail(
          WagerTransactionEntity,
          {
            externalTransactionId:
              'refund-amount-mismatch',
          },
        );

      expect(
        refund.status,
      ).toBe('REJECTED');

      expect(
        refund.failureCode,
      ).toBe(
        'REFERENCE_AMOUNT_MISMATCH',
      );
    },
  );

  test(
    'rolls back a processed BET and credits the wallet',
    async () => {
      const playerId =
        'player-rollback-bet';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:bet-for-rollback',

          transactionId:
            'internal-bet-for-rollback',

          externalTransactionId:
            'bet-for-rollback',

          playerId,
          walletId,

          roundId:
            'round-rollback-bet',

          gameId:
            'game-rollback-bet',

          type:
            'BET',

          amount:
            '30.00',
        }),
      );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:rollback-bet-1',

          transactionId:
            'internal-rollback-bet-1',

          externalTransactionId:
            'rollback-bet-1',

          playerId,
          walletId,

          roundId:
            'round-rollback-bet',

          gameId:
            'game-rollback-bet',

          type:
            'ROLLBACK',

          amount:
            '30.00',

          referenceTransactionId:
            'bet-for-rollback',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const finalWallet =
        await verificationEm.findOneOrFail(
          WalletEntity,
          {
            id: walletId,
          },
        );

      const rollback =
        await verificationEm.findOneOrFail(
          WagerTransactionEntity,
          {
            externalTransactionId:
              'rollback-bet-1',
          },
        );

      const ledgerEntries =
        await verificationEm.find(
          LedgerEntryEntity,
          {
            walletId,
          },
        );

      expect(
        finalWallet.balance,
      ).toBe('100.00');

      expect(
        rollback.status,
      ).toBe('PROCESSED');

      expect(
        ledgerEntries,
      ).toHaveLength(2);

      const rollbackLedger =
        ledgerEntries.find(
          (entry) =>
            entry.entryType ===
            'ROLLBACK',
        );

      expect(
        rollbackLedger?.amount,
      ).toBe('30.00');
    },
  );

  test(
    'rolls back a processed WIN and debits the wallet',
    async () => {
      const playerId =
        'player-rollback-win';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:win-for-rollback',

          transactionId:
            'internal-win-for-rollback',

          externalTransactionId:
            'win-for-rollback',

          playerId,
          walletId,

          roundId:
            'round-rollback-win',

          gameId:
            'game-rollback-win',

          type:
            'WIN',

          amount:
            '40.00',
        }),
      );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:rollback-win-1',

          transactionId:
            'internal-rollback-win-1',

          externalTransactionId:
            'rollback-win-1',

          playerId,
          walletId,

          roundId:
            'round-rollback-win',

          gameId:
            'game-rollback-win',

          type:
            'ROLLBACK',

          amount:
            '40.00',

          referenceTransactionId:
            'win-for-rollback',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const finalWallet =
        await verificationEm.findOneOrFail(
          WalletEntity,
          {
            id: walletId,
          },
        );

      const rollback =
        await verificationEm.findOneOrFail(
          WagerTransactionEntity,
          {
            externalTransactionId:
              'rollback-win-1',
          },
        );

      const rollbackLedger =
        await verificationEm.findOneOrFail(
          LedgerEntryEntity,
          {
            transactionId:
              'internal-rollback-win-1',
          },
        );

      expect(
        finalWallet.balance,
      ).toBe('100.00');

      expect(
        rollback.status,
      ).toBe('PROCESSED');

      expect(
        rollbackLedger.amount,
      ).toBe('40.00');
    },
  );

  test(
    'rejects a second ROLLBACK for the same reference',
    async () => {
      const playerId =
        'player-double-rollback';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:bet-double-rollback',

          transactionId:
            'internal-bet-double-rollback',

          externalTransactionId:
            'bet-double-rollback',

          playerId,
          walletId,

          roundId:
            'round-double-rollback',

          gameId:
            'game-double-rollback',

          type:
            'BET',

          amount:
            '30.00',
        }),
      );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:rollback-first',

          transactionId:
            'internal-rollback-first',

          externalTransactionId:
            'rollback-first',

          playerId,
          walletId,

          roundId:
            'round-double-rollback',

          gameId:
            'game-double-rollback',

          type:
            'ROLLBACK',

          amount:
            '30.00',

          referenceTransactionId:
            'bet-double-rollback',
        }),
      );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:rollback-second',

          transactionId:
            'internal-rollback-second',

          externalTransactionId:
            'rollback-second',

          playerId,
          walletId,

          roundId:
            'round-double-rollback',

          gameId:
            'game-double-rollback',

          type:
            'ROLLBACK',

          amount:
            '30.00',

          referenceTransactionId:
            'bet-double-rollback',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const secondRollback =
        await verificationEm.findOneOrFail(
          WagerTransactionEntity,
          {
            externalTransactionId:
              'rollback-second',
          },
        );

      const rollbackLedgers =
        await verificationEm.find(
          LedgerEntryEntity,
          {
            walletId,

            entryType:
              'ROLLBACK',
          },
        );

      expect(
        secondRollback.status,
      ).toBe('REJECTED');

      expect(
        secondRollback.failureCode,
      ).toBe(
        'REFERENCE_ALREADY_ROLLED_BACK',
      );

      expect(
        rollbackLedgers,
      ).toHaveLength(1);
    },
  );

  test(
    'rejects rollback of WIN when reversal would make wallet balance negative',
    async () => {
      const playerId =
        'player-negative-rollback';

      const walletId =
        await createWallet(
          playerId,
          '10.00',
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:win-negative-rollback',

          transactionId:
            'internal-win-negative-rollback',

          externalTransactionId:
            'win-negative-rollback',

          playerId,
          walletId,

          roundId:
            'round-negative-rollback',

          gameId:
            'game-negative-rollback',

          type:
            'WIN',

          amount:
            '50.00',
        }),
      );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:spend-win-balance',

          transactionId:
            'internal-spend-win-balance',

          externalTransactionId:
            'spend-win-balance',

          playerId,
          walletId,

          roundId:
            'round-spend-win',

          gameId:
            'game-negative-rollback',

          type:
            'BET',

          amount:
            '40.00',
        }),
      );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:rollback-negative-win',

          transactionId:
            'internal-rollback-negative-win',

          externalTransactionId:
            'rollback-negative-win',

          playerId,
          walletId,

          roundId:
            'round-negative-rollback',

          gameId:
            'game-negative-rollback',

          type:
            'ROLLBACK',

          amount:
            '50.00',

          referenceTransactionId:
            'win-negative-rollback',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const finalWallet =
        await verificationEm.findOneOrFail(
          WalletEntity,
          {
            id: walletId,
          },
        );

      const rollback =
        await verificationEm.findOneOrFail(
          WagerTransactionEntity,
          {
            externalTransactionId:
              'rollback-negative-win',
          },
        );

      const rollbackLedgerEntries =
        await verificationEm.find(
          LedgerEntryEntity,
          {
            transactionId:
              'internal-rollback-negative-win',
          },
        );

      expect(
        finalWallet.balance,
      ).toBe('20.00');

      expect(
        rollback.status,
      ).toBe('REJECTED');

      expect(
        rollback.failureCode,
      ).toBe(
        'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
      );

      expect(
        rollbackLedgerEntries,
      ).toHaveLength(0);
    },
  );

  test(
    'creates processed and balance changed outbox events for BET',
    async () => {
      const playerId =
        'player-outbox-bet';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:outbox-bet',

          transactionId:
            'internal-outbox-bet',

          externalTransactionId:
            'outbox-bet',

          playerId,
          walletId,

          roundId:
            'round-outbox-bet',

          gameId:
            'game-outbox-bet',

          type:
            'BET',

          amount:
            '25.00',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const transactionEvents =
        await verificationEm.find(
          OutboxEventEntity,
          {
            aggregateId:
              'internal-outbox-bet',
          },
        );

      const walletEvents =
        await verificationEm.find(
          OutboxEventEntity,
          {
            aggregateId:
              walletId,
          },
        );

      expect(
        transactionEvents,
      ).toHaveLength(1);

      expect(
        transactionEvents[0]
          ?.eventType,
      ).toBe(
        'WagerTransactionProcessed.v1',
      );

      expect(
        walletEvents,
      ).toHaveLength(1);

      expect(
        walletEvents[0]
          ?.eventType,
      ).toBe(
        'WalletBalanceChanged.v1',
      );

      expect(
        walletEvents[0]
          ?.payload,
      ).toMatchObject({
        balance: {
          amount:
            '75.00',
          currency:
            'BRL',
        },
      });
    },
  );

  test(
    'creates only processed outbox event for LOSS',
    async () => {
      const playerId =
        'player-outbox-loss';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:outbox-loss',

          transactionId:
            'internal-outbox-loss',

          externalTransactionId:
            'outbox-loss',

          playerId,
          walletId,

          roundId:
            'round-outbox-loss',

          gameId:
            'game-outbox-loss',

          type:
            'LOSS',

          amount:
            '25.00',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const transactionEvents =
        await verificationEm.find(
          OutboxEventEntity,
          {
            aggregateId:
              'internal-outbox-loss',
          },
        );

      const walletEvents =
        await verificationEm.find(
          OutboxEventEntity,
          {
            aggregateId:
              walletId,
          },
        );

      expect(
        transactionEvents,
      ).toHaveLength(1);

      expect(
        transactionEvents[0]
          ?.eventType,
      ).toBe(
        'WagerTransactionProcessed.v1',
      );

      expect(
        walletEvents,
      ).toHaveLength(0);
    },
  );

  test(
    'creates rejected outbox event for rejected BET',
    async () => {
      const playerId =
        'player-outbox-rejected';

      const walletId =
        await createWallet(
          playerId,
          '10.00',
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:outbox-rejected',

          transactionId:
            'internal-outbox-rejected',

          externalTransactionId:
            'outbox-rejected',

          playerId,
          walletId,

          roundId:
            'round-outbox-rejected',

          gameId:
            'game-outbox-rejected',

          type:
            'BET',

          amount:
            '50.00',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const events =
        await verificationEm.find(
          OutboxEventEntity,
          {
            aggregateId:
              'internal-outbox-rejected',
          },
        );

      expect(
        events,
      ).toHaveLength(1);

      expect(
        events[0]
          ?.eventType,
      ).toBe(
        'WagerTransactionRejected.v1',
      );

      expect(
        events[0]
          ?.payload,
      ).toMatchObject({
        failureCode:
          'INSUFFICIENT_FUNDS',
      });
    },
  );

  test(
    'creates pending reference outbox event when reference does not exist',
    async () => {
      const playerId =
        'player-outbox-pending';

      const walletId =
        await createWallet(
          playerId,
        );

      await new ProcessWagerService(
        orm.em.fork(),
      ).execute(
        createInput({
          idempotencyKey:
            'provider-a:outbox-pending',

          transactionId:
            'internal-outbox-pending',

          externalTransactionId:
            'outbox-pending',

          playerId,
          walletId,

          roundId:
            'round-outbox-pending',

          gameId:
            'game-outbox-pending',

          type:
            'REFUND',

          amount:
            '25.00',

          referenceTransactionId:
            'missing-reference',
        }),
      );

      const verificationEm =
        orm.em.fork();

      const events =
        await verificationEm.find(
          OutboxEventEntity,
          {
            aggregateId:
              'internal-outbox-pending',
          },
        );

      expect(
        events,
      ).toHaveLength(1);

      expect(
        events[0]
          ?.eventType,
      ).toBe(
        'WagerTransactionPendingReference.v1',
      );
    },
  );
});