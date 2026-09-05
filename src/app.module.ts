import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';

import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import { ProcessWagerService } from './application/wager/process-wager.service.js';
import { WagerHttpController } from './application/wager/wager-http.controller.js';
import { WagerQueryHttpController } from './application/wager/wager-query-http.controller.js';

import { CreateWalletService } from './application/wallet/create-wallet.service.js';
import { WalletHttpController } from './application/wallet/wallet-http.controller.js';

import { ReconciliationService } from './application/reconciliation/reconciliation.service.js';
import { ReconciliationHttpController } from './application/reconciliation/reconciliation-http.controller.js';

import { HealthService } from './application/health/health.service.js';
import { HealthController } from './application/health/health.controller.js';

import { MetricsController } from './application/observability/metrics.controller.js';

import { ObservabilityService } from './infrastructure/observability/observability.service.js';

import { WagerSqsRuntimeService } from './infrastructure/sqs/wager-sqs-runtime.service.js';

import { BackgroundWorkersRuntimeService } from './infrastructure/background-workers-runtime.service.js';

import { NoOpAuthGuard } from './infrastructure/auth/no-op-auth.guard.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    MikroOrmModule.forRoot({
      driver:
        PostgreSqlDriver,

      host:
        process.env
          .DATABASE_HOST ??
        'localhost',

      port:
        Number(
          process.env
            .DATABASE_PORT ??
            '55432',
        ),

      dbName:
        process.env
          .DATABASE_NAME ??
        'jungle_wagering',

      user:
        process.env
          .DATABASE_USER ??
        'jungle',

      password:
        process.env
          .DATABASE_PASSWORD ??
        'jungle',

      entities: [
        './dist/**/*.entity.js',
      ],

      entitiesTs: [
        './src/**/*.entity.ts',
      ],

      extensions: [
        Migrator,
      ],

      migrations: {
        path:
          './dist/migrations',

        pathTs:
          './src/migrations',
      },
    }),
  ],

  controllers: [
    WagerHttpController,
    WagerQueryHttpController,
    WalletHttpController,
    ReconciliationHttpController,
    HealthController,
    MetricsController,
  ],

  providers: [
    ProcessWagerService,
    CreateWalletService,
    ReconciliationService,
    HealthService,

    ObservabilityService,

    WagerSqsRuntimeService,
    BackgroundWorkersRuntimeService,

    {
      provide: APP_GUARD,
      useClass: NoOpAuthGuard,
    },
  ],
})
export class AppModule {}
