import { Money } from '../money/money.js';

export type LedgerDirection =
  | 'DEBIT'
  | 'CREDIT';

export type LedgerEntryType =
  | 'OPENING'
  | 'BET'
  | 'WIN'
  | 'REFUND'
  | 'ROLLBACK';

export interface CreateLedgerEntryInput {
  id: string;
  walletId: string;
  playerId: string;
  transactionId: string;
  type: LedgerEntryType;
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export class LedgerEntry {
  private constructor(
    private readonly id: string,
    private readonly walletId: string,
    private readonly playerId: string,
    private readonly transactionId: string,
    private readonly type: LedgerEntryType,
    private readonly direction: LedgerDirection,
    private readonly amount: Money,
    private readonly balanceBefore: Money,
    private readonly balanceAfter: Money,
    private readonly createdAt: Date,
  ) {}

  static create(
    input: CreateLedgerEntryInput,
  ): LedgerEntry {
    if (!input.amount.isPositive()) {
      throw new Error('Ledger amount must be positive');
    }

    if (
      input.amount.getCurrency() !== input.balanceBefore.getCurrency() ||
      input.amount.getCurrency() !== input.balanceAfter.getCurrency()
    ) {
      throw new Error('Ledger currency mismatch');
    }

    if (
      input.balanceBefore.isNegative() ||
      input.balanceAfter.isNegative()
    ) {
      throw new Error('Ledger balance cannot be negative');
    }

    const expectedBalance =
      input.direction === 'CREDIT'
        ? input.balanceBefore.add(input.amount)
        : input.balanceBefore.subtract(input.amount);

    if (!expectedBalance.equals(input.balanceAfter)) {
      throw new Error('Ledger balance arithmetic mismatch');
    }

    return new LedgerEntry(
      input.id,
      input.walletId,
      input.playerId,
      input.transactionId,
      input.type,
      input.direction,
      input.amount,
      input.balanceBefore,
      input.balanceAfter,
      input.createdAt ?? new Date(),
    );
  }

  static rehydrate(
    input: CreateLedgerEntryInput,
  ): LedgerEntry {
    return new LedgerEntry(
      input.id,
      input.walletId,
      input.playerId,
      input.transactionId,
      input.type,
      input.direction,
      input.amount,
      input.balanceBefore,
      input.balanceAfter,
      input.createdAt ?? new Date(),
    );
  }

  getId(): string {
    return this.id;
  }

  getWalletId(): string {
    return this.walletId;
  }

  getPlayerId(): string {
    return this.playerId;
  }

  getTransactionId(): string {
    return this.transactionId;
  }

  getType(): LedgerEntryType {
    return this.type;
  }

  getDirection(): LedgerDirection {
    return this.direction;
  }

  getAmount(): Money {
    return this.amount;
  }

  getBalanceBefore(): Money {
    return this.balanceBefore;
  }

  getBalanceAfter(): Money {
    return this.balanceAfter;
  }

  getCreatedAt(): Date {
    return this.createdAt;
  }
}
