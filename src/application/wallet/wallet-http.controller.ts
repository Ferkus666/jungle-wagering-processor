import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import {
  EntityManager,
} from '@mikro-orm/postgresql';

import {
  CreateWalletService,
} from './create-wallet.service.js';

import {
  WalletEntity,
} from '../../domain/wallet/wallet.entity.js';

import {
  LedgerEntryEntity,
} from '../../domain/ledger/ledger-entry.entity.js';

interface CreateWalletBody {
  playerId: string;

  initialBalance: {
    amount: string;
    currency: string;
  };
}

interface LedgerCursor {
  createdAt: string;
  id: string;
}

@Controller('wallets')
export class WalletHttpController {
  constructor(
    private readonly createWalletService:
      CreateWalletService,

    private readonly em:
      EntityManager,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWallet(
    @Body()
    body: CreateWalletBody,
  ) {
    this.validateBody(
      body,
    );

    try {
      return await this
        .createWalletService
        .execute({
          playerId:
            body.playerId,

          initialBalance: {
            amount:
              body.initialBalance.amount,

            currency:
              body.initialBalance.currency,
          },
        });
    } catch (error) {
      this.mapError(
        error,
      );
    }
  }

  @Get(':id')
  async getWallet(
    @Param('id')
    id: string,
  ) {
    const wallet =
      await this.em.findOne(
        WalletEntity,
        {
          id,
        },
      );

    if (!wallet) {
      throw new HttpException(
        'WALLET_NOT_FOUND',
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      id:
        wallet.id,

      playerId:
        wallet.playerId,

      balance: {
        amount:
          wallet.balance,

        currency:
          wallet.currency,
      },

      version:
        wallet.version,
    };
  }

  @Get(':id/ledger')
  async getLedger(
    @Param('id')
    walletId: string,

    @Query('cursor')
    cursorValue:
      | string
      | undefined,

    @Query('limit')
    limitValue:
      | string
      | undefined,
  ) {
    const wallet =
      await this.em.findOne(
        WalletEntity,
        {
          id:
            walletId,
        },
      );

    if (!wallet) {
      throw new HttpException(
        'WALLET_NOT_FOUND',
        HttpStatus.NOT_FOUND,
      );
    }

    const limit =
      this.parseLimit(
        limitValue,
      );

    const cursor =
      cursorValue
        ? this.decodeCursor(
            cursorValue,
          )
        : undefined;

    /*
     * createdAt + id formam um cursor
     * estável e determinístico.
     *
     * Buscamos limit + 1 para descobrir
     * se existe uma próxima página sem
     * usar OFFSET.
     */
    const where:
      | {
          walletId: string;
        }
      | {
          walletId: string;
          $or: Array<
            | {
                createdAt: {
                  $gt: Date;
                };
              }
            | {
                createdAt: Date;
                id: {
                  $gt: string;
                };
              }
          >;
        } =
      cursor
        ? {
            walletId,

            $or: [
              {
                createdAt: {
                  $gt:
                    new Date(
                      cursor.createdAt,
                    ),
                },
              },
              {
                createdAt:
                  new Date(
                    cursor.createdAt,
                  ),

                id: {
                  $gt:
                    cursor.id,
                },
              },
            ],
          }
        : {
            walletId,
          };

    const entries =
      await this.em.find(
        LedgerEntryEntity,
        where,
        {
          orderBy: {
            createdAt:
              'ASC',

            id:
              'ASC',
          },

          limit:
            limit + 1,
        },
      );

    const hasNextPage =
      entries.length > limit;

    const page =
      hasNextPage
        ? entries.slice(
            0,
            limit,
          )
        : entries;

    const lastEntry =
      page.at(
        -1,
      );

    return {
      items:
        page.map(
          (entry) => ({
            id:
              entry.id,

            transactionId:
              entry.transactionId,

            entryType:
              entry.entryType,

            direction:
              entry.direction,

            money: {
              amount:
                entry.amount,

              currency:
                entry.currency,
            },

            balanceBefore: {
              amount:
                entry.balanceBefore,

              currency:
                entry.currency,
            },

            balanceAfter: {
              amount:
                entry.balanceAfter,

              currency:
                entry.currency,
            },

            createdAt:
              entry.createdAt
                .toISOString(),
          }),
        ),

      nextCursor:
        hasNextPage &&
        lastEntry
          ? this.encodeCursor({
              createdAt:
                lastEntry.createdAt
                  .toISOString(),

              id:
                lastEntry.id,
            })
          : null,
    };
  }

  private parseLimit(
    value:
      | string
      | undefined,
  ): number {
    if (
      value === undefined
    ) {
      return 50;
    }

    if (
      !/^\d+$/.test(
        value,
      )
    ) {
      throw new BadRequestException(
        'INVALID_LIMIT',
      );
    }

    const parsed =
      Number(
        value,
      );

    if (
      !Number.isInteger(
        parsed,
      ) ||
      parsed < 1 ||
      parsed > 100
    ) {
      throw new BadRequestException(
        'INVALID_LIMIT',
      );
    }

    return parsed;
  }

  private encodeCursor(
    cursor: LedgerCursor,
  ): string {
    return Buffer
      .from(
        JSON.stringify(
          cursor,
        ),
        'utf8',
      )
      .toString(
        'base64url',
      );
  }

  private decodeCursor(
    value: string,
  ): LedgerCursor {
    try {
      const parsed =
        JSON.parse(
          Buffer
            .from(
              value,
              'base64url',
            )
            .toString(
              'utf8',
            ),
        ) as Partial<
          LedgerCursor
        >;

      if (
        typeof parsed.createdAt !==
          'string' ||
        Number.isNaN(
          Date.parse(
            parsed.createdAt,
          ),
        ) ||
        typeof parsed.id !==
          'string' ||
        parsed.id.trim().length ===
          0
      ) {
        throw new Error(
          'INVALID_CURSOR',
        );
      }

      return {
        createdAt:
          parsed.createdAt,

        id:
          parsed.id,
      };
    } catch {
      throw new BadRequestException(
        'INVALID_CURSOR',
      );
    }
  }

  private validateBody(
    body: CreateWalletBody,
  ): void {
    if (
      !body ||
      typeof body.playerId !==
        'string' ||
      body.playerId.trim().length ===
        0
    ) {
      throw new BadRequestException(
        'INVALID_PLAYER_ID',
      );
    }

    if (
      !body.initialBalance ||
      typeof body.initialBalance
        .amount !== 'string' ||
      typeof body.initialBalance
        .currency !== 'string'
    ) {
      throw new BadRequestException(
        'INVALID_INITIAL_BALANCE',
      );
    }

    if (
      !/^\d+\.\d{2}$/.test(
        body.initialBalance.amount,
      )
    ) {
      throw new BadRequestException(
        'INVALID_INITIAL_BALANCE_AMOUNT',
      );
    }

    if (
      !/^[A-Z]{3}$/.test(
        body.initialBalance.currency,
      )
    ) {
      throw new BadRequestException(
        'INVALID_CURRENCY',
      );
    }
  }

  private mapError(
    error: unknown,
  ): never {
    const message =
      error instanceof Error
        ? error.message
        : 'UNKNOWN_ERROR';

    if (
      message ===
      'WALLET_ALREADY_EXISTS'
    ) {
      throw new ConflictException(
        'WALLET_ALREADY_EXISTS',
      );
    }

    if (
      message ===
        'INITIAL_BALANCE_CANNOT_BE_NEGATIVE' ||
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

    throw new HttpException(
      'WALLET_CREATION_FAILURE',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
