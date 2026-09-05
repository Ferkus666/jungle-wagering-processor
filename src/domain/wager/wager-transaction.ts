import type { LedgerDirection } from '../ledger/ledger-entry.js';
import { Money } from '../money/money.js';

export type WagerTransactionKind =
  | 'OPENING'
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

/**
 * Tipos aceitos pelas entradas externas HTTP/SQS.
 *
 * OPENING é uma operação exclusivamente interna.
 */
export type WagerTransactionType = Exclude<
  WagerTransactionKind,
  'OPENING'
>;

export type WagerTransactionStatus =
  | 'PENDING'
  | 'PENDING_REFERENCE'
  | 'PROCESSED'
  | 'REJECTED'
  | 'FAILED';

export type FailureCode = string;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;

  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;

  kind: WagerTransactionKind;
  money: Money;

  referenceExternalTransactionId?: string;

  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;

  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;

  kind: WagerTransactionKind;
  money: Money;

  referenceExternalTransactionId?: string;

  createdAt: Date;

  status: WagerTransactionStatus;

  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class InvalidTransactionStateError extends Error {
  constructor(
    transactionId: string,
    status: WagerTransactionStatus,
  ) {
    super(
      `Transaction ${transactionId} is terminal and cannot transition from ${status}`,
    );

    this.name = 'InvalidTransactionStateError';
  }
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,

    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,

    public readonly kind: WagerTransactionKind,
    public readonly money: Money,

    public readonly referenceExternalTransactionId:
      | string
      | undefined,

    public readonly createdAt: Date,

    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(
    props: CreateWagerTransactionProps,
  ): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new Error(
        'Wager transaction money must be positive',
      );
    }

    const requiresReference =
      props.kind === 'REFUND' ||
      props.kind === 'ROLLBACK';

    if (
      requiresReference &&
      !props.referenceExternalTransactionId
    ) {
      throw new Error(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,

      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,

      props.kind,
      props.money,

      props.referenceExternalTransactionId,

      props.createdAt ?? new Date(),

      'PENDING',
    );
  }

  /**
   * Reidratação não revalida regras de criação
   * nem regras de transição.
   *
   * O estado já foi anteriormente persistido
   * e está apenas sendo reconstruído.
   */
  static rehydrate(
    state: WagerTransactionState,
  ): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,

      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,

      state.kind,
      state.money,

      state.referenceExternalTransactionId,

      state.createdAt,

      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
  ): void {
    this.assertNotTerminal();

    if (
      this.requiresReference() &&
      !referenceTransactionId
    ) {
      throw new Error(
        `${this.kind} requires a resolved reference transaction`,
      );
    }

    this._referenceTransactionId =
      referenceTransactionId;

    this._status = 'PROCESSED';

    this._failureCode = undefined;

    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal();

    if (!this.requiresReference()) {
      throw new Error(
        `${this.kind} does not require a reference transaction`,
      );
    }

    this._status = 'PENDING_REFERENCE';
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();
    this.assertFailureCode(code);

    this._status = 'REJECTED';
    this._failureCode = code;
    this._processedAt = new Date();
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();
    this.assertFailureCode(code);

    this._status = 'FAILED';
    this._failureCode = code;
    this._processedAt = new Date();
  }

  isTerminal(): boolean {
    return (
      this._status === 'PROCESSED' ||
      this._status === 'REJECTED' ||
      this._status === 'FAILED'
    );
  }

  affectsBalance(): boolean {
    return this.kind !== 'LOSS';
  }

  requiresReference(): boolean {
    return (
      this.kind === 'REFUND' ||
      this.kind === 'ROLLBACK'
    );
  }

  matchesPayload(
    payloadHash: string,
  ): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection {
    switch (this.kind) {
      case 'OPENING':
      case 'WIN':
      case 'REFUND':
        return 'CREDIT';

      case 'BET':
        return 'DEBIT';

      case 'ROLLBACK': {
        if (!reference) {
          throw new Error(
            'ROLLBACK requires the referenced transaction to determine ledger direction',
          );
        }

        if (
          reference.kind !== 'BET' &&
          reference.kind !== 'WIN' &&
          reference.kind !== 'REFUND'
        ) {
          throw new Error(
            `ROLLBACK cannot reference ${reference.kind}`,
          );
        }

        const referenceDirection =
          reference.ledgerDirectionFor();

        return referenceDirection === 'DEBIT'
          ? 'CREDIT'
          : 'DEBIT';
      }

      case 'LOSS':
        throw new Error(
          'LOSS does not affect balance and has no ledger direction',
        );
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
      );
    }
  }

  private assertFailureCode(
    code: FailureCode,
  ): void {
    if (!code.trim()) {
      throw new Error(
        'Failure code must not be empty',
      );
    }
  }
}