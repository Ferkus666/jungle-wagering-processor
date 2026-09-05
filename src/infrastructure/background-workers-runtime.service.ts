import {
  BeforeApplicationShutdown,
  Injectable,
} from '@nestjs/common';

import {
  CreateQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import {
  EntityManager,
} from '@mikro-orm/postgresql';

import { PendingReferenceWorkerService } from '../application/wager/pending-reference-worker.service.js';
import { OutboxPublisherService } from './outbox/outbox-publisher.service.js';
import { SqsOutboxTransport } from './sqs/sqs-outbox.transport.js';
import { ObservabilityService } from './observability/observability.service.js';

@Injectable()
export class BackgroundWorkersRuntimeService
  implements BeforeApplicationShutdown
{
  private client?: SQSClient;

  private outboxPublisher?:
    OutboxPublisherService;

  private pendingReferenceWorker?:
    PendingReferenceWorkerService;

  private outboxLoop?: Promise<void>;

  private pendingReferenceLoop?:
    Promise<void>;

  private stopping = false;

  private started = false;

  constructor(
    private readonly em:
      EntityManager,

    private readonly observability:
      ObservabilityService,
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.stopping = false;

    this.client =
      new SQSClient({
        region:
          process.env
            .AWS_REGION ??
          'us-east-1',

        endpoint:
          process.env
            .SQS_ENDPOINT ??
          'http://localhost:4566',

        credentials: {
          accessKeyId:
            process.env
              .AWS_ACCESS_KEY_ID ??
            'test',

          secretAccessKey:
            process.env
              .AWS_SECRET_ACCESS_KEY ??
            'test',
        },
      });

    const eventQueueUrl =
      await this.ensureQueue(
        process.env
          .SQS_WAGER_EVENTS_QUEUE_NAME ??
          'wager-events.fifo',
      );

    /*
     * Cada worker recebe seu próprio
     * EntityManager.
     *
     * Isso evita compartilhamento de
     * Unit of Work entre loops de
     * background independentes.
     */
    this.outboxPublisher =
      new OutboxPublisherService(
        this.em.fork(),

        new SqsOutboxTransport(
          this.client,
          eventQueueUrl,
        ),

        this.observability,
      );

    this.pendingReferenceWorker =
      new PendingReferenceWorkerService(
        this.em.fork(),

        this.readPositiveInteger(
          'PENDING_REFERENCE_MAX_ATTEMPTS',
          5,
        ),

        this.readNonNegativeInteger(
          'PENDING_REFERENCE_BASE_BACKOFF_SECONDS',
          5,
        ),

        this.observability,
      );

    /*
     * Os dois loops são independentes.
     *
     * Não fazemos await aqui porque eles
     * devem permanecer executando durante
     * toda a vida da aplicação.
     */
    this.outboxLoop =
      this.runOutboxLoop();

    this.pendingReferenceLoop =
      this.runPendingReferenceLoop();

    this.started = true;

    this.observability.info(
      'background_workers.started',
    );
  }

  async beforeApplicationShutdown():
    Promise<void> {
    /*
     * Impede novos ciclos.
     */
    this.stopping = true;

    /*
     * Aguarda qualquer operação que já
     * esteja em andamento terminar.
     */
    await Promise.all([
      this.outboxLoop,
      this.pendingReferenceLoop,
    ]);

    if (this.client) {
      this.client.destroy();
    }

    this.client = undefined;

    this.outboxPublisher =
      undefined;

    this.pendingReferenceWorker =
      undefined;

    this.outboxLoop =
      undefined;

    this.pendingReferenceLoop =
      undefined;

    this.started = false;

    this.observability.info(
      'background_workers.stopped',
    );
  }

  private async runOutboxLoop():
    Promise<void> {
    const intervalMilliseconds =
      this.readPositiveInteger(
        'OUTBOX_POLL_INTERVAL_MS',
        500,
      );

    const batchSize =
      this.readPositiveInteger(
        'OUTBOX_BATCH_SIZE',
        20,
      );

    while (!this.stopping) {
      try {
        await this.updateOutboxLagMetric();

        await this.outboxPublisher
          ?.publishBatch(
            batchSize,
          );

        await this.updateOutboxLagMetric();
      } catch (error) {
        /*
         * Uma falha transitória de banco
         * ou SQS não encerra o publisher.
         *
         * O evento continua persistido na
         * Outbox e poderá ser tentado
         * novamente.
         */
        this.observability
          .incrementCounter(
            'background_worker_errors_total',
            {
              worker:
                'OUTBOX',
            },
          );

        this.observability.error(
          'background_worker.outbox.failed',
          {
            failureCode:
              error instanceof Error
                ? error.message
                : 'UNKNOWN_ERROR',
          },
        );
      }

      if (!this.stopping) {
        await this.wait(
          intervalMilliseconds,
        );
      }
    }
  }

  private async runPendingReferenceLoop():
    Promise<void> {
    const intervalMilliseconds =
      this.readPositiveInteger(
        'PENDING_REFERENCE_POLL_INTERVAL_MS',
        500,
      );

    while (!this.stopping) {
      try {
        const processed =
          await this
            .pendingReferenceWorker
            ?.processDueOne();

        /*
         * Se encontramos uma transação
         * vencida, tentamos imediatamente
         * buscar a próxima.
         *
         * Isso permite esvaziar um backlog
         * sem esperar 500 ms entre cada
         * transação.
         */
        if (processed) {
          continue;
        }
      } catch (error) {
        /*
         * Erros transitórios também não
         * encerram permanentemente este
         * worker.
         */
        this.observability
          .incrementCounter(
            'background_worker_errors_total',
            {
              worker:
                'PENDING_REFERENCE',
            },
          );

        this.observability.error(
          'background_worker.pending_reference.failed',
          {
            failureCode:
              error instanceof Error
                ? error.message
                : 'UNKNOWN_ERROR',
          },
        );
      }

      if (!this.stopping) {
        await this.wait(
          intervalMilliseconds,
        );
      }
    }
  }


  private async updateOutboxLagMetric():
    Promise<void> {
    const rows =
      await this.em.fork().execute<
        Array<{
          lagMs:
            | number
            | string
            | null;
        }>
      >(
        `
          select
            coalesce(
              extract(
                epoch from (
                  now() - min("created_at")
                )
              ) * 1000,
              0
            )::double precision as "lagMs"
          from "outbox_events"
          where "published_at" is null
        `,
      );

    const value =
      Number(
        rows[0]?.lagMs ??
          0,
      );

    this.observability.setGauge(
      'outbox_lag_ms',
      Math.max(
        value,
        0,
      ),
    );
  }

  private async ensureQueue(
    queueName: string,
  ): Promise<string> {
    if (!this.client) {
      throw new Error(
        'SQS_CLIENT_NOT_INITIALIZED',
      );
    }

    const result =
      await this.client.send(
        new CreateQueueCommand({
          QueueName:
            queueName,

          Attributes: {
            FifoQueue:
              'true',

            ContentBasedDeduplication:
              'false',
          },
        }),
      );

    if (!result.QueueUrl) {
      throw new Error(
        `SQS_QUEUE_URL_MISSING:${queueName}`,
      );
    }

    return result.QueueUrl;
  }

  private readPositiveInteger(
    environmentVariable: string,
    fallback: number,
  ): number {
    const rawValue =
      process.env[
        environmentVariable
      ] ??
      String(fallback);

    const parsed =
      Number.parseInt(
        rawValue,
        10,
      );

    if (
      !Number.isInteger(
        parsed,
      ) ||
      parsed < 1
    ) {
      throw new Error(
        `${environmentVariable}_MUST_BE_POSITIVE_INTEGER`,
      );
    }

    return parsed;
  }

  private readNonNegativeInteger(
    environmentVariable: string,
    fallback: number,
  ): number {
    const rawValue =
      process.env[
        environmentVariable
      ] ??
      String(fallback);

    const parsed =
      Number.parseInt(
        rawValue,
        10,
      );

    if (
      !Number.isInteger(
        parsed,
      ) ||
      parsed < 0
    ) {
      throw new Error(
        `${environmentVariable}_MUST_BE_NON_NEGATIVE_INTEGER`,
      );
    }

    return parsed;
  }

  private async wait(
    milliseconds: number,
  ): Promise<void> {
    await new Promise<void>(
      (resolve) => {
        setTimeout(
          resolve,
          milliseconds,
        );
      },
    );
  }
}