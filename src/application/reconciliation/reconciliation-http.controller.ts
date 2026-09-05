import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';

import {
  ReconciliationService,
} from './reconciliation.service.js';

@Controller()
export class ReconciliationHttpController {
  constructor(
    private readonly reconciliationService:
      ReconciliationService,
  ) {}

  @Post(
    'wallets/:walletId/reconciliation',
  )
  @HttpCode(HttpStatus.OK)
  async reconcileWallet(
    @Param('walletId')
    walletId: string,
  ) {
    return this.executeReconciliation(
      walletId,
    );
  }

  @Get(
    'reconciliation/wallets/:walletId',
  )
  async reconcileWalletLegacy(
    @Param('walletId')
    walletId: string,
  ) {
    return this.executeReconciliation(
      walletId,
    );
  }

  private async executeReconciliation(
    walletId: string,
  ) {
    try {
      return await this
        .reconciliationService
        .reconcileWallet(
          walletId,
        );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'UNKNOWN_ERROR';

      if (
        message ===
        'WALLET_NOT_FOUND'
      ) {
        throw new HttpException(
          'WALLET_NOT_FOUND',
          HttpStatus.NOT_FOUND,
        );
      }

      if (
        message ===
        'LEDGER_CURRENCY_MISMATCH'
      ) {
        throw new HttpException(
          'LEDGER_CURRENCY_MISMATCH',
          HttpStatus.CONFLICT,
        );
      }

      throw new HttpException(
        'RECONCILIATION_FAILURE',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
