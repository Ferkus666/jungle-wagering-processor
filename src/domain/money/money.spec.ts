import { describe, expect, test } from 'bun:test';
import { Money } from './money.js';

describe('Money', () => {
  test('creates money from decimal string', () => {
    const money = Money.from('100.00', 'BRL');

    expect(money.getAmount()).toBe('100.00');
    expect(money.getCurrency()).toBe('BRL');
  });

  test('adds money with same currency', () => {
    const first = Money.from('10.50', 'BRL');
    const second = Money.from('5.25', 'BRL');

    expect(first.add(second).getAmount()).toBe('15.75');
  });

  test('subtracts money with same currency', () => {
    const first = Money.from('10.00', 'BRL');
    const second = Money.from('3.25', 'BRL');

    expect(first.subtract(second).getAmount()).toBe('6.75');
  });

  test('rejects invalid decimal format', () => {
    expect(() => Money.from('10', 'BRL')).toThrow();
    expect(() => Money.from('10.1', 'BRL')).toThrow();
    expect(() => Money.from('10.123', 'BRL')).toThrow();
  });

  test('rejects different currencies on addition', () => {
    const brl = Money.from('10.00', 'BRL');
    const usd = Money.from('5.00', 'USD');

    expect(() => brl.add(usd)).toThrow('Currency mismatch');
  });

  test('does not lose decimal precision', () => {
    const first = Money.from('0.10', 'BRL');
    const second = Money.from('0.20', 'BRL');

    expect(first.add(second).getAmount()).toBe('0.30');
  });

  test('creates zero', () => {
    expect(Money.zero('BRL').getAmount()).toBe('0.00');
  });

  test('negates money', () => {
    expect(Money.from('10.00', 'BRL').negate().getAmount()).toBe('-10.00');
  });
});