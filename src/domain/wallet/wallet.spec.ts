import { describe, expect, test } from 'bun:test';
import { Money } from '../money/money.js';
import { InsufficientFundsError, Wallet } from './wallet.js';

describe('Wallet', () => {
  test('credits money', () => {
    const wallet = new Wallet(
      'wallet-1',
      'player-1',
      Money.from('100.00', 'BRL'),
    );

    wallet.credit(Money.from('50.00', 'BRL'));

    expect(wallet.getBalance().getAmount()).toBe('150.00');
  });

  test('debits money', () => {
    const wallet = new Wallet(
      'wallet-1',
      'player-1',
      Money.from('100.00', 'BRL'),
    );

    wallet.debit(Money.from('30.00', 'BRL'));

    expect(wallet.getBalance().getAmount()).toBe('70.00');
  });

  test('allows debit equal to current balance', () => {
    const wallet = new Wallet(
      'wallet-1',
      'player-1',
      Money.from('100.00', 'BRL'),
    );

    wallet.debit(Money.from('100.00', 'BRL'));

    expect(wallet.getBalance().getAmount()).toBe('0.00');
  });

  test('rejects debit that would make balance negative', () => {
    const wallet = new Wallet(
      'wallet-1',
      'player-1',
      Money.from('100.00', 'BRL'),
    );

    expect(() =>
      wallet.debit(Money.from('100.01', 'BRL')),
    ).toThrow(InsufficientFundsError);

    expect(wallet.getBalance().getAmount()).toBe('100.00');
  });

  test('rejects zero or negative credit', () => {
    const wallet = new Wallet(
      'wallet-1',
      'player-1',
      Money.from('100.00', 'BRL'),
    );

    expect(() =>
      wallet.credit(Money.from('0.00', 'BRL')),
    ).toThrow();

    expect(() =>
      wallet.credit(Money.from('-10.00', 'BRL')),
    ).toThrow();
  });

  test('rejects zero or negative debit', () => {
    const wallet = new Wallet(
      'wallet-1',
      'player-1',
      Money.from('100.00', 'BRL'),
    );

    expect(() =>
      wallet.debit(Money.from('0.00', 'BRL')),
    ).toThrow();

    expect(() =>
      wallet.debit(Money.from('-10.00', 'BRL')),
    ).toThrow();
  });

  test('rejects different currency', () => {
    const wallet = new Wallet(
      'wallet-1',
      'player-1',
      Money.from('100.00', 'BRL'),
    );

    expect(() =>
      wallet.debit(Money.from('10.00', 'USD')),
    ).toThrow('Currency mismatch');
  });
});