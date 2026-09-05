import {
  describe,
  expect,
  test,
} from 'bun:test';

import { Money } from '../money/money.js';

import {
  InvalidTransactionStateError,
  WagerTransaction,
  type CreateWagerTransactionProps,
  type WagerTransactionState,
} from './wager-transaction.js';

describe('WagerTransaction', () => {
  function createProps(
    overrides: Partial<CreateWagerTransactionProps> = {},
  ): CreateWagerTransactionProps {
    return {
      id: 'transaction-1',
      providerId: 'provider-a',
      externalTransactionId: 'external-transaction-1',
      idempotencyKey:
        'provider-a:external-transaction-1',
      payloadHash: 'payload-hash-1',

      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',

      kind: 'BET',
      money: Money.from('25.00', 'BRL'),

      ...overrides,
    };
  }

  test('creates a transaction in PENDING status', () => {
    const transaction =
      WagerTransaction.create(
        createProps(),
      );

    expect(
      transaction.status,
    ).toBe('PENDING');

    expect(
      transaction.failureCode,
    ).toBeUndefined();

    expect(
      transaction.processedAt,
    ).toBeUndefined();
  });

  test('preserves transaction identity and business data', () => {
    const transaction =
      WagerTransaction.create(
        createProps(),
      );

    expect(transaction.id).toBe(
      'transaction-1',
    );

    expect(
      transaction.providerId,
    ).toBe('provider-a');

    expect(
      transaction.externalTransactionId,
    ).toBe(
      'external-transaction-1',
    );

    expect(
      transaction.idempotencyKey,
    ).toBe(
      'provider-a:external-transaction-1',
    );

    expect(
      transaction.walletId,
    ).toBe('wallet-1');

    expect(
      transaction.playerId,
    ).toBe('player-1');

    expect(
      transaction.roundId,
    ).toBe('round-1');

    expect(
      transaction.gameId,
    ).toBe('game-1');

    expect(
      transaction.kind,
    ).toBe('BET');

    expect(
      transaction.money.getAmount(),
    ).toBe('25.00');

    expect(
      transaction.money.getCurrency(),
    ).toBe('BRL');
  });

  test('rejects zero or negative transaction money', () => {
    expect(() =>
      WagerTransaction.create(
        createProps({
          money:
            Money.from(
              '0.00',
              'BRL',
            ),
        }),
      ),
    ).toThrow(
      'Wager transaction money must be positive',
    );

    expect(() =>
      WagerTransaction.create(
        createProps({
          money:
            Money.from(
              '-10.00',
              'BRL',
            ),
        }),
      ),
    ).toThrow(
      'Wager transaction money must be positive',
    );
  });

  test('requires external reference for REFUND', () => {
    expect(() =>
      WagerTransaction.create(
        createProps({
          kind: 'REFUND',
          referenceExternalTransactionId:
            undefined,
        }),
      ),
    ).toThrow(
      'REFUND requires referenceExternalTransactionId',
    );
  });

  test('requires external reference for ROLLBACK', () => {
    expect(() =>
      WagerTransaction.create(
        createProps({
          kind: 'ROLLBACK',
          referenceExternalTransactionId:
            undefined,
        }),
      ),
    ).toThrow(
      'ROLLBACK requires referenceExternalTransactionId',
    );
  });

  test('identifies which transactions require references', () => {
    const bet =
      WagerTransaction.create(
        createProps({
          kind: 'BET',
        }),
      );

    const refund =
      WagerTransaction.create(
        createProps({
          kind: 'REFUND',
          referenceExternalTransactionId:
            'bet-external-1',
        }),
      );

    const rollback =
      WagerTransaction.create(
        createProps({
          kind: 'ROLLBACK',
          referenceExternalTransactionId:
            'bet-external-1',
        }),
      );

    expect(
      bet.requiresReference(),
    ).toBe(false);

    expect(
      refund.requiresReference(),
    ).toBe(true);

    expect(
      rollback.requiresReference(),
    ).toBe(true);
  });

  test('identifies transactions that affect wallet balance', () => {
    const bet =
      WagerTransaction.create(
        createProps({
          kind: 'BET',
        }),
      );

    const win =
      WagerTransaction.create(
        createProps({
          kind: 'WIN',
        }),
      );

    const loss =
      WagerTransaction.create(
        createProps({
          kind: 'LOSS',
        }),
      );

    expect(
      bet.affectsBalance(),
    ).toBe(true);

    expect(
      win.affectsBalance(),
    ).toBe(true);

    expect(
      loss.affectsBalance(),
    ).toBe(false);
  });

  test('moves a transaction to PENDING_REFERENCE', () => {
    const transaction =
      WagerTransaction.create(
        createProps({
          kind: 'REFUND',
          referenceExternalTransactionId:
            'bet-external-1',
        }),
      );

    transaction.markPendingReference();

    expect(
      transaction.status,
    ).toBe(
      'PENDING_REFERENCE',
    );

    expect(
      transaction.isTerminal(),
    ).toBe(false);
  });

  test('does not allow BET to become PENDING_REFERENCE', () => {
    const transaction =
      WagerTransaction.create(
        createProps({
          kind: 'BET',
        }),
      );

    expect(() =>
      transaction.markPendingReference(),
    ).toThrow(
      'BET does not require a reference transaction',
    );
  });

  test('marks transaction as PROCESSED', () => {
    const transaction =
      WagerTransaction.create(
        createProps({
          kind: 'BET',
        }),
      );

    const processedAt =
      new Date(
        '2026-09-04T12:00:00.000Z',
      );

    transaction.markProcessed(
      undefined,
      processedAt,
    );

    expect(
      transaction.status,
    ).toBe('PROCESSED');

    expect(
      transaction.processedAt,
    ).toEqual(processedAt);

    expect(
      transaction.isTerminal(),
    ).toBe(true);
  });

  test('requires resolved internal reference before processing REFUND', () => {
    const transaction =
      WagerTransaction.create(
        createProps({
          kind: 'REFUND',
          referenceExternalTransactionId:
            'bet-external-1',
        }),
      );

    expect(() =>
      transaction.markProcessed(
        undefined,
        new Date(),
      ),
    ).toThrow(
      'REFUND requires a resolved reference transaction',
    );
  });

  test('stores resolved internal reference when processing REFUND', () => {
    const transaction =
      WagerTransaction.create(
        createProps({
          kind: 'REFUND',
          referenceExternalTransactionId:
            'bet-external-1',
        }),
      );

    const processedAt =
      new Date(
        '2026-09-04T12:00:00.000Z',
      );

    transaction.markProcessed(
      'internal-bet-1',
      processedAt,
    );

    expect(
      transaction.status,
    ).toBe('PROCESSED');

    expect(
      transaction.referenceTransactionId,
    ).toBe(
      'internal-bet-1',
    );
  });

  test('marks transaction as REJECTED with a failure code', () => {
    const transaction =
      WagerTransaction.create(
        createProps(),
      );

    transaction.reject(
      'INSUFFICIENT_FUNDS',
    );

    expect(
      transaction.status,
    ).toBe('REJECTED');

    expect(
      transaction.failureCode,
    ).toBe(
      'INSUFFICIENT_FUNDS',
    );

    expect(
      transaction.isTerminal(),
    ).toBe(true);

    expect(
      transaction.processedAt,
    ).toBeInstanceOf(Date);
  });

  test('marks transaction as FAILED with a failure code', () => {
    const transaction =
      WagerTransaction.create(
        createProps(),
      );

    transaction.fail(
      'PERMANENT_INFRASTRUCTURE_FAILURE',
    );

    expect(
      transaction.status,
    ).toBe('FAILED');

    expect(
      transaction.failureCode,
    ).toBe(
      'PERMANENT_INFRASTRUCTURE_FAILURE',
    );

    expect(
      transaction.isTerminal(),
    ).toBe(true);
  });

  test('does not allow empty failure code', () => {
    const transaction =
      WagerTransaction.create(
        createProps(),
      );

    expect(() =>
      transaction.reject('   '),
    ).toThrow(
      'Failure code must not be empty',
    );
  });

  test('terminal PROCESSED transaction cannot transition again', () => {
    const transaction =
      WagerTransaction.create(
        createProps(),
      );

    transaction.markProcessed(
      undefined,
      new Date(),
    );

    expect(() =>
      transaction.reject(
        'SOME_FAILURE',
      ),
    ).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('terminal REJECTED transaction cannot transition again', () => {
    const transaction =
      WagerTransaction.create(
        createProps(),
      );

    transaction.reject(
      'INSUFFICIENT_FUNDS',
    );

    expect(() =>
      transaction.markProcessed(
        undefined,
        new Date(),
      ),
    ).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('terminal FAILED transaction cannot transition again', () => {
    const transaction =
      WagerTransaction.create(
        createProps(),
      );

    transaction.fail(
      'PERMANENT_FAILURE',
    );

    expect(() =>
      transaction.markPendingReference(),
    ).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('matches the original payload hash', () => {
    const transaction =
      WagerTransaction.create(
        createProps({
          payloadHash:
            'expected-hash',
        }),
      );

    expect(
      transaction.matchesPayload(
        'expected-hash',
      ),
    ).toBe(true);

    expect(
      transaction.matchesPayload(
        'different-hash',
      ),
    ).toBe(false);
  });

  test('returns DEBIT ledger direction for BET', () => {
    const transaction =
      WagerTransaction.create(
        createProps({
          kind: 'BET',
        }),
      );

    expect(
      transaction.ledgerDirectionFor(),
    ).toBe('DEBIT');
  });

  test('returns CREDIT ledger direction for WIN and REFUND', () => {
    const win =
      WagerTransaction.create(
        createProps({
          id: 'win-1',
          kind: 'WIN',
        }),
      );

    const refund =
      WagerTransaction.create(
        createProps({
          id: 'refund-1',
          kind: 'REFUND',
          referenceExternalTransactionId:
            'bet-external-1',
        }),
      );

    expect(
      win.ledgerDirectionFor(),
    ).toBe('CREDIT');

    expect(
      refund.ledgerDirectionFor(),
    ).toBe('CREDIT');
  });

  test('LOSS has no ledger direction', () => {
    const transaction =
      WagerTransaction.create(
        createProps({
          kind: 'LOSS',
        }),
      );

    expect(() =>
      transaction.ledgerDirectionFor(),
    ).toThrow(
      'LOSS does not affect balance and has no ledger direction',
    );
  });

  test('ROLLBACK reverses the ledger direction of BET', () => {
    const reference =
      WagerTransaction.create(
        createProps({
          id: 'bet-1',
          kind: 'BET',
        }),
      );

    const rollback =
      WagerTransaction.create(
        createProps({
          id: 'rollback-1',
          externalTransactionId:
            'rollback-external-1',
          idempotencyKey:
            'provider-a:rollback-external-1',
          kind: 'ROLLBACK',
          referenceExternalTransactionId:
            'bet-external-1',
        }),
      );

    expect(
      rollback.ledgerDirectionFor(
        reference,
      ),
    ).toBe('CREDIT');
  });

  test('ROLLBACK reverses the ledger direction of WIN', () => {
    const reference =
      WagerTransaction.create(
        createProps({
          id: 'win-1',
          kind: 'WIN',
        }),
      );

    const rollback =
      WagerTransaction.create(
        createProps({
          id: 'rollback-1',
          kind: 'ROLLBACK',
          referenceExternalTransactionId:
            'win-external-1',
        }),
      );

    expect(
      rollback.ledgerDirectionFor(
        reference,
      ),
    ).toBe('DEBIT');
  });

  test('ROLLBACK requires the referenced transaction to determine direction', () => {
    const rollback =
      WagerTransaction.create(
        createProps({
          kind: 'ROLLBACK',
          referenceExternalTransactionId:
            'bet-external-1',
        }),
      );

    expect(() =>
      rollback.ledgerDirectionFor(),
    ).toThrow(
      'ROLLBACK requires the referenced transaction to determine ledger direction',
    );
  });

  test('rehydrate reconstructs persisted state without revalidating transitions', () => {
    const processedAt =
      new Date(
        '2026-09-04T12:00:00.000Z',
      );

    const state: WagerTransactionState = {
      id: 'transaction-1',
      providerId: 'provider-a',
      externalTransactionId:
        'external-transaction-1',
      idempotencyKey:
        'provider-a:external-transaction-1',
      payloadHash:
        'payload-hash-1',

      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',

      kind: 'REFUND',

      money:
        Money.from(
          '25.00',
          'BRL',
        ),

      referenceExternalTransactionId:
        'bet-external-1',

      createdAt:
        new Date(
          '2026-09-04T11:00:00.000Z',
        ),

      status: 'PROCESSED',

      referenceTransactionId:
        'internal-bet-1',

      processedAt,
    };

    const transaction =
      WagerTransaction.rehydrate(
        state,
      );

    expect(
      transaction.status,
    ).toBe('PROCESSED');

    expect(
      transaction.referenceTransactionId,
    ).toBe(
      'internal-bet-1',
    );

    expect(
      transaction.processedAt,
    ).toEqual(processedAt);

    expect(
      transaction.isTerminal(),
    ).toBe(true);
  });
});