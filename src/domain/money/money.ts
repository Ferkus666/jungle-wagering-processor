import { Decimal } from 'decimal.js';

export class Money {
  private constructor(
    private readonly value: Decimal,
    private readonly currency: string,
  ) {}

  static from(amount: string, currency: string): Money {
    if (!/^-?\d+\.\d{2}$/.test(amount)) {
      throw new Error('Money amount must be a decimal string with exactly 2 decimal places');
    }

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error('Currency must be a 3-letter uppercase code');
    }

    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from('0.00', currency);
  }

  add(other: Money): Money {
    this.ensureSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.ensureSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.ensureSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  toJSON(): { amount: string; currency: string } {
    return {
      amount: this.getAmount(),
      currency: this.currency,
    };
  }

  toString(): string {
    return this.getAmount();
  }

  getAmount(): string {
    return this.value.toFixed(2);
  }

  getCurrency(): string {
    return this.currency;
  }

  private ensureSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error('Currency mismatch');
    }
  }
}