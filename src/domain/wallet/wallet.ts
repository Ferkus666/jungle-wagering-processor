import { Money } from '../money/money.js';

export class InsufficientFundsError extends Error {
  constructor() {
    super('Insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

export class Wallet {
  private constructor(
    private readonly id: string,
    private readonly playerId: string,
    private balance: Money,
    private version: number,
  ) {}

  static open(
    id: string,
    playerId: string,
    initialBalance: Money,
  ): Wallet {
    if (!id || id.trim().length === 0) {
      throw new Error('Wallet id is required');
    }

    if (!playerId || playerId.trim().length === 0) {
      throw new Error('Player id is required');
    }

    if (initialBalance.isNegative()) {
      throw new Error(
        'Initial balance cannot be negative',
      );
    }

    return new Wallet(
      id,
      playerId,
      initialBalance,
      1,
    );
  }

  static rehydrate(
    id: string,
    playerId: string,
    balance: Money,
    version: number,
  ): Wallet {
    return new Wallet(
      id,
      playerId,
      balance,
      version,
    );
  }

  credit(amount: Money): void {
    this.ensureSameCurrency(amount);

    if (!amount.isPositive()) {
      throw new Error(
        'Credit amount must be positive',
      );
    }

    this.balance =
      this.balance.add(amount);

    this.version += 1;
  }

  debit(amount: Money): void {
    this.ensureSameCurrency(amount);

    if (!amount.isPositive()) {
      throw new Error(
        'Debit amount must be positive',
      );
    }

    const resultingBalance =
      this.balance.subtract(amount);

    if (resultingBalance.isNegative()) {
      throw new InsufficientFundsError();
    }

    this.balance =
      resultingBalance;

    this.version += 1;
  }

  getId(): string {
    return this.id;
  }

  getPlayerId(): string {
    return this.playerId;
  }

  getBalance(): Money {
    return this.balance;
  }

  getVersion(): number {
    return this.version;
  }

  private ensureSameCurrency(
    amount: Money,
  ): void {
    if (
      this.balance.getCurrency() !==
      amount.getCurrency()
    ) {
      throw new Error(
        'Currency mismatch',
      );
    }
  }
}
