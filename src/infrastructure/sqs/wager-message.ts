export interface WagerMessageMoney {
  amount: string;
  currency: string;
}

export type WagerMessageKind =
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

export interface WagerMessageData {
  providerId: string;

  externalTransactionId: string;

  idempotencyKey: string;

  playerId: string;

  walletId: string;

  roundId: string;

  gameId: string;

  kind: WagerMessageKind;

  money: WagerMessageMoney;

  referenceExternalTransactionId?: string;
}

export interface WagerMessageEnvelope {
  messageId: string;

  type: string;

  occurredAt: string;

  data: WagerMessageData;
}