import {
  Injectable,
} from '@nestjs/common';

import {
  EntityManager,
} from '@mikro-orm/postgresql';

import {
  Decimal,
} from 'decimal.js';

import {
  WalletEntity,
} from '../../domain/wallet/wallet.entity.js';

import {
  LedgerEntryEntity,
} from '../../domain/ledger/ledger-entry.entity.js';

export interface ReconciliationResult {
  walletId: string;
  playerId: string;
  currency: string;
  storedBalance: string;
  reconstructedBalance: string;
  consistent: boolean;
  ledgerEntries: number;
}

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly em:
      EntityManager,
  ) {}

  async reconcileWallet(
    walletId: string,
  ): Promise<ReconciliationResult> {
    const wallet =
      await this.em.findOne(
        WalletEntity,
        { id: walletId },
      );

    if (!wallet) {
      throw new Error(
        'WALLET_NOT_FOUND',
      );
    }

    const ledger =
      await this.em.find(
        LedgerEntryEntity,
        { walletId },
        {
          orderBy: {
            createdAt: 'ASC',
            id: 'ASC',
          },
        },
      );

    let reconstructed =
      new Decimal('0.00');

    for (const entry of ledger) {
      if (
        entry.currency !==
        wallet.currency
      ) {
        throw new Error(
          'LEDGER_CURRENCY_MISMATCH',
        );
      }

      const expectedBefore =
        reconstructed.toFixed(2);

      if (
        entry.balanceBefore !==
        expectedBefore
      ) {
        return {
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          storedBalance: wallet.balance,
          reconstructedBalance:
            expectedBefore,
          consistent: false,
          ledgerEntries:
            ledger.length,
        };
      }

      reconstructed =
        entry.direction === 'CREDIT'
          ? reconstructed.plus(
              entry.amount,
            )
          : reconstructed.minus(
              entry.amount,
            );

      if (
        entry.balanceAfter !==
        reconstructed.toFixed(2)
      ) {
        return {
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          storedBalance: wallet.balance,
          reconstructedBalance:
            reconstructed.toFixed(2),
          consistent: false,
          ledgerEntries:
            ledger.length,
        };
      }
    }

    const reconstructedBalance =
      reconstructed.toFixed(2);

    return {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      storedBalance: wallet.balance,
      reconstructedBalance,
      consistent:
        new Decimal(
          wallet.balance,
        ).equals(
          reconstructed,
        ),
      ledgerEntries:
        ledger.length,
    };
  }
}
