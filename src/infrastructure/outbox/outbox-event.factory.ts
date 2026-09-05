import { randomUUID } from 'node:crypto';

import { OutboxEventEntity } from './outbox-event.entity.js';

interface WagerEventInput {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  type: string;
  amount: string;
  currency: string;
  status: string;
  failureCode?: string;
}

interface WalletBalanceChangedInput {
  walletId: string;
  playerId: string;
  amount: string;
  currency: string;
  transactionId: string;
}

export class OutboxEventFactory {
  static wagerProcessed(
    input: WagerEventInput,
  ): OutboxEventEntity {
    return this.create(
      'WagerTransactionProcessed.v1',
      'WagerTransaction',
      input.transactionId,
      {
        transactionId:
          input.transactionId,

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

        kind:
          input.type,

        money: {
          amount:
            input.amount,

          currency:
            input.currency,
        },

        status:
          input.status,
      },
    );
  }

  static wagerRejected(
    input: WagerEventInput,
  ): OutboxEventEntity {
    return this.create(
      'WagerTransactionRejected.v1',
      'WagerTransaction',
      input.transactionId,
      {
        transactionId:
          input.transactionId,

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

        kind:
          input.type,

        money: {
          amount:
            input.amount,

          currency:
            input.currency,
        },

        status:
          input.status,

        failureCode:
          input.failureCode,
      },
    );
  }

  static wagerPendingReference(
    input: WagerEventInput,
  ): OutboxEventEntity {
    return this.create(
      'WagerTransactionPendingReference.v1',
      'WagerTransaction',
      input.transactionId,
      {
        transactionId:
          input.transactionId,

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

        kind:
          input.type,

        money: {
          amount:
            input.amount,

          currency:
            input.currency,
        },

        status:
          input.status,
      },
    );
  }

  static walletBalanceChanged(
    input: WalletBalanceChangedInput,
  ): OutboxEventEntity {
    return this.create(
      'WalletBalanceChanged.v1',
      'Wallet',
      input.walletId,
      {
        walletId:
          input.walletId,

        playerId:
          input.playerId,

        transactionId:
          input.transactionId,

        balance: {
          amount:
            input.amount,

          currency:
            input.currency,
        },
      },
    );
  }

  private static create(
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): OutboxEventEntity {
    const event =
      new OutboxEventEntity();

    event.id =
      randomUUID();

    event.eventType =
      eventType;

    event.aggregateType =
      aggregateType;

    event.aggregateId =
      aggregateId;

    event.payload =
      payload;

    event.attempts =
      0;

    event.nextAttemptAt =
      new Date();

    event.createdAt =
      new Date();

    event.updatedAt =
      new Date();

    return event;
  }
}