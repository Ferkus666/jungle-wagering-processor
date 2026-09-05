import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';

import type {
  Response,
} from 'express';

import {
  randomUUID,
} from 'node:crypto';

import {
  ObservabilityService,
} from '../../infrastructure/observability/observability.service.js';

import {
  ProcessWagerService,
} from './process-wager.service.js';

import type {
  ProcessWagerResult,
} from './process-wager.result.js';

interface WagerMoneyBody {
  amount: string;
  currency: string;
}

type WagerKind =
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

interface CreateWagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: WagerMoneyBody;
  referenceExternalTransactionId?: string;
}

@Controller('wagering')
export class WagerHttpController {
  constructor(
    private readonly processWagerService:
      ProcessWagerService,

    private readonly observability:
      ObservabilityService,
  ) {}

  @Post('transactions')
  async createTransaction(
    @Headers('idempotency-key')
    idempotencyKey:
      | string
      | undefined,

    @Body()
    body:
      CreateWagerBody,

    @Res({
      passthrough: true,
    })
    response:
      Response,
  ): Promise<ProcessWagerResult> {
    const startedAt =
      performance.now();

    const correlationId =
      randomUUID();

    if (
      !idempotencyKey ||
      idempotencyKey.trim().length === 0
    ) {
      this.observability.warn(
        'wager.request.rejected',
        {
          correlationId,

          failureCode:
            'IDEMPOTENCY_KEY_REQUIRED',
        },
      );

      throw new BadRequestException(
        'IDEMPOTENCY_KEY_REQUIRED',
      );
    }

    this.validateBody(
      body,
    );

    const internalTransactionId =
      randomUUID();

    this.observability.info(
      'wager.processing.started',
      {
        correlationId,

        transactionId:
          internalTransactionId,

        walletId:
          body.walletId,

        providerId:
          body.providerId,
      },
    );

    let result:
      | ProcessWagerResult
      | undefined;

    try {
      result =
        await this
          .processWagerService
          .execute({
            idempotencyKey,

            transactionId:
              internalTransactionId,

            providerId:
              body.providerId,

            externalTransactionId:
              body.externalTransactionId,

            playerId:
              body.playerId,

            walletId:
              body.walletId,

            roundId:
              body.roundId,

            gameId:
              body.gameId,

            type:
              body.kind,

            amount:
              body.money.amount,

            currency:
              body.money.currency,

            referenceExternalTransactionId:
              body
                .referenceExternalTransactionId,
          });
    } catch (error) {
      const durationMs =
        performance.now() -
        startedAt;

      this.observability.observeLatency(
        'wager_processing_duration_ms',
        durationMs,
        {
          source:
            'HTTP',

          result:
            'ERROR',
        },
      );

      this.observability.error(
        'wager.processing.failed',
        {
          correlationId,

          transactionId:
            internalTransactionId,

          walletId:
            body.walletId,

          providerId:
            body.providerId,

          durationMs,
        },
      );

      this.mapError(
        error,
      );
    }

    if (!result) {
      const durationMs =
        performance.now() -
        startedAt;

      this.observability.incrementCounter(
        'wager_transactions_total',
        {
          status:
            'FAILED',
        },
      );

      this.observability.observeLatency(
        'wager_processing_duration_ms',
        durationMs,
        {
          source:
            'HTTP',

          result:
            'FAILED',
        },
      );

      this.observability.error(
        'wager.processing.result_missing',
        {
          correlationId,

          transactionId:
            internalTransactionId,

          walletId:
            body.walletId,

          providerId:
            body.providerId,

          status:
            'FAILED',

          durationMs,
        },
      );

      throw new HttpException(
        'TRANSACTION_RESULT_NOT_AVAILABLE',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const durationMs =
      performance.now() -
      startedAt;

    this.observability.incrementCounter(
      'wager_transactions_total',
      {
        status:
          result.status,
      },
    );

    if (
      result.idempotentReplay
    ) {
      this.observability.incrementCounter(
        'wager_duplicates_total',
        {
          source:
            'HTTP',
        },
      );
    }

    this.observability.observeLatency(
      'wager_processing_duration_ms',
      durationMs,
      {
        source:
          'HTTP',

        result:
          result.status,
      },
    );

    this.observability.info(
      'wager.processing.completed',
      {
        correlationId,

        transactionId:
          result.transactionId,

        walletId:
          body.walletId,

        providerId:
          body.providerId,

        status:
          result.status,

        idempotentReplay:
          result.idempotentReplay,

        durationMs,
      },
    );

    if (
      result.status ===
      'PENDING_REFERENCE'
    ) {
      response.status(
        HttpStatus.ACCEPTED,
      );
    } else if (
      result.status ===
      'REJECTED'
    ) {
      response.status(
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    } else {
      response.status(
        HttpStatus.OK,
      );
    }

    return result;
  }

  private validateBody(
    body:
      CreateWagerBody,
  ): void {
    if (!body) {
      throw new BadRequestException(
        'INVALID_PAYLOAD',
      );
    }

    const requiredStrings = [
      body.providerId,
      body.externalTransactionId,
      body.playerId,
      body.walletId,
      body.roundId,
      body.gameId,
      body.kind,
    ];

    if (
      requiredStrings.some(
        (value) =>
          typeof value !==
            'string' ||
          value.trim().length ===
            0,
      )
    ) {
      throw new BadRequestException(
        'INVALID_PAYLOAD',
      );
    }

    if (
      body.kind !== 'BET' &&
      body.kind !== 'WIN' &&
      body.kind !== 'LOSS' &&
      body.kind !== 'REFUND' &&
      body.kind !== 'ROLLBACK'
    ) {
      throw new BadRequestException(
        'INVALID_WAGER_KIND',
      );
    }

    if (
      !body.money ||
      typeof body.money.amount !==
        'string' ||
      typeof body.money.currency !==
        'string'
    ) {
      throw new BadRequestException(
        'INVALID_MONEY',
      );
    }

    if (
      !/^\d+\.\d{2}$/.test(
        body.money.amount,
      )
    ) {
      throw new BadRequestException(
        'INVALID_MONEY_AMOUNT',
      );
    }

    if (
      !/^[A-Z]{3}$/.test(
        body.money.currency,
      )
    ) {
      throw new BadRequestException(
        'INVALID_CURRENCY',
      );
    }

    if (
      (
        body.kind ===
          'REFUND' ||
        body.kind ===
          'ROLLBACK'
      ) &&
      (
        !body
          .referenceExternalTransactionId ||
        body
          .referenceExternalTransactionId
          .trim()
          .length === 0
      )
    ) {
      throw new BadRequestException(
        'REFERENCE_EXTERNAL_TRANSACTION_REQUIRED',
      );
    }
  }

  private mapError(
    error:
      unknown,
  ): never {
    const message =
      error instanceof Error
        ? error.message
        : 'UNKNOWN_ERROR';

    if (
      message ===
      'IDEMPOTENCY_KEY_CONFLICT'
    ) {
      throw new ConflictException(
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }

    if (
      message ===
      'REFERENCE_TRANSACTION_REQUIRED'
    ) {
      throw new BadRequestException(
        'REFERENCE_EXTERNAL_TRANSACTION_REQUIRED',
      );
    }

    if (
      message ===
        'Unsupported wager type' ||
      message ===
        'Wager amount must be positive' ||
      message.includes(
        'Money amount',
      ) ||
      message.includes(
        'Currency',
      )
    ) {
      throw new BadRequestException(
        message,
      );
    }

    if (
      message.includes(
        'Wallet not found',
      )
    ) {
      throw new HttpException(
        'WALLET_NOT_FOUND',
        HttpStatus.NOT_FOUND,
      );
    }

    throw new HttpException(
      'TRANSIENT_PROCESSING_FAILURE',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}