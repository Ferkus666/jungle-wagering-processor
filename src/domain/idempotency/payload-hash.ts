import { createHash } from 'node:crypto';

import type { ProcessWagerInput } from '../../application/wager/process-wager.input.js';

function canonicalize(
  value: unknown,
): unknown {
  if (
    value === null ||
    typeof value !== 'object'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(
      canonicalize,
    );
  }

  const object =
    value as Record<
      string,
      unknown
    >;

  const sortedKeys =
    Object.keys(object).sort();

  const result: Record<
    string,
    unknown
  > = {};

  for (
    const key of sortedKeys
  ) {
    result[key] =
      canonicalize(
        object[key],
      );
  }

  return result;
}

export function createWagerPayloadHash(
  input: ProcessWagerInput,
): string {
  /*
   * Somente dados de negócio entram
   * no hash.
   *
   * Não entram:
   *
   * - idempotencyKey
   * - transactionId interno
   * - metadados de transporte
   */
  const businessPayload = {
    providerId:
      input.providerId,

    externalTransactionId:
      input.externalTransactionId,

    playerId:
      input.playerId,

    walletId:
      input.walletId,

    roundId:
      input.roundId,

    gameId:
      input.gameId,

    type:
      input.type,

    amount:
      input.amount,

    currency:
      input.currency,

    referenceTransactionId:
      input.referenceExternalTransactionId ??
      input.referenceTransactionId ??
      null,
  };

  const canonicalPayload =
    JSON.stringify(
      canonicalize(
        businessPayload,
      ),
    );

  return createHash(
    'sha256',
  )
    .update(
      canonicalPayload,
    )
    .digest('hex');
}