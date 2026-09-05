import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
} from '@nestjs/common';

import {
  EntityManager,
} from '@mikro-orm/postgresql';

import {
  WagerTransactionEntity,
} from '../../domain/wager/wager-transaction.entity.js';

@Controller('wagering/transactions')
export class WagerQueryHttpController {
  constructor(
    private readonly em:
      EntityManager,
  ) {}

  @Get('provider/:providerId/:externalTransactionId')
  async getByProviderTransaction(
    @Param('providerId')
    providerId: string,

    @Param('externalTransactionId')
    externalTransactionId: string,
  ) {
    const transaction =
      await this.em.findOne(
        WagerTransactionEntity,
        {
          providerId,
          externalTransactionId,
        },
      );

    if (!transaction) {
      throw new HttpException(
        'TRANSACTION_NOT_FOUND',
        HttpStatus.NOT_FOUND,
      );
    }

    return this.toResponse(
      transaction,
    );
  }

  @Get(':id')
  async getByInternalId(
    @Param('id')
    id: string,
  ) {
    const transaction =
      await this.em.findOne(
        WagerTransactionEntity,
        {
          transactionId:
            id,
        },
      );

    if (!transaction) {
      throw new HttpException(
        'TRANSACTION_NOT_FOUND',
        HttpStatus.NOT_FOUND,
      );
    }

    return this.toResponse(
      transaction,
    );
  }

  private toResponse(
    transaction:
      WagerTransactionEntity,
  ) {
    return {
      transactionId:
        transaction.transactionId,

      providerId:
        transaction.providerId,

      externalTransactionId:
        transaction.externalTransactionId,

      playerId:
        transaction.playerId,

      walletId:
        transaction.walletId,

      roundId:
        transaction.roundId,

      gameId:
        transaction.gameId,

      kind:
        transaction.type,

      money: {
        amount:
          transaction.amount,

        currency:
          transaction.currency,
      },

      status:
        transaction.status,

      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId ??
        null,

      failureCode:
        transaction.failureCode ??
        null,

      createdAt:
        transaction.createdAt
          .toISOString(),

      processedAt:
        transaction.processedAt
          ?.toISOString() ??
        null,
    };
  }
}
