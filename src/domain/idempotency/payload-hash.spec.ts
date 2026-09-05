import {
  describe,
  expect,
  test,
} from 'bun:test';

import { createWagerPayloadHash } from './payload-hash.js';

import type { ProcessWagerInput } from '../../application/wager/process-wager.input.js';

describe(
  'createWagerPayloadHash',
  () => {
    function createInput(
      overrides: Partial<ProcessWagerInput> = {},
    ): ProcessWagerInput {
      return {
        idempotencyKey:
          'provider-a:transaction-1',

        transactionId:
          'internal-transaction-1',

        providerId:
          'provider-a',

        externalTransactionId:
          'external-transaction-1',

        playerId:
          'player-1',

        walletId:
          '11111111-1111-1111-1111-111111111111',

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

        ...overrides,
      };
    }

    test(
      'generates the same hash for the same business payload',
      () => {
        const first =
          createWagerPayloadHash(
            createInput(),
          );

        const second =
          createWagerPayloadHash(
            createInput(),
          );

        expect(first).toBe(
          second,
        );
      },
    );

    test(
      'generates a different hash when the amount changes',
      () => {
        const first =
          createWagerPayloadHash(
            createInput({
              amount:
                '25.00',
            }),
          );

        const second =
          createWagerPayloadHash(
            createInput({
              amount:
                '30.00',
            }),
          );

        expect(first).not.toBe(
          second,
        );
      },
    );

    test(
      'generates a different hash when another business field changes',
      () => {
        const first =
          createWagerPayloadHash(
            createInput({
              roundId:
                'round-1',
            }),
          );

        const second =
          createWagerPayloadHash(
            createInput({
              roundId:
                'round-2',
            }),
          );

        expect(first).not.toBe(
          second,
        );
      },
    );

    test(
      'does not include idempotency key in the payload hash',
      () => {
        const first =
          createWagerPayloadHash(
            createInput({
              idempotencyKey:
                'key-one',
            }),
          );

        const second =
          createWagerPayloadHash(
            createInput({
              idempotencyKey:
                'key-two',
            }),
          );

        expect(first).toBe(
          second,
        );
      },
    );

    test(
      'does not include internal transaction id in the payload hash',
      () => {
        const first =
          createWagerPayloadHash(
            createInput({
              transactionId:
                'internal-one',
            }),
          );

        const second =
          createWagerPayloadHash(
            createInput({
              transactionId:
                'internal-two',
            }),
          );

        expect(first).toBe(
          second,
        );
      },
    );
  },
);