import {
  NestFactory,
} from '@nestjs/core';

import {
  AppModule,
} from './app.module.js';

import {
  WagerSqsRuntimeService,
} from './infrastructure/sqs/wager-sqs-runtime.service.js';

import {
  BackgroundWorkersRuntimeService,
} from './infrastructure/background-workers-runtime.service.js';

async function bootstrap():
  Promise<void> {
  const app =
    await NestFactory.create(
      AppModule,
    );

  /*
   * Habilita SIGTERM e SIGINT.
   *
   * Assim os runtimes podem terminar
   * operações em andamento antes do
   * processo encerrar.
   */
  app.enableShutdownHooks();

  /*
   * Consumer de transações recebidas
   * pelo SQS.
   */
  const sqsRuntime =
    app.get(
      WagerSqsRuntimeService,
    );

  await sqsRuntime.start();

  /*
   * Workers internos:
   *
   * - Outbox Publisher
   * - Pending Reference Worker
   *
   * Eles existem como providers, mas
   * somente o processo real iniciado
   * por main.ts liga os loops.
   *
   * Testes que importam AppModule não
   * iniciam processamento de background.
   */
  const backgroundWorkersRuntime =
    app.get(
      BackgroundWorkersRuntimeService,
    );

  await backgroundWorkersRuntime.start();

  await app.listen(
    process.env.PORT ??
      3000,
  );
}

await bootstrap();