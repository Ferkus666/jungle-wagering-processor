import {
  BeforeApplicationShutdown,
  Injectable,
} from '@nestjs/common';

import {
  CreateQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { ProcessWagerService } from '../../application/wager/process-wager.service.js';

import {
  ObservabilityService,
} from '../observability/observability.service.js';

import { WagerSqsConsumerService } from './wager-sqs-consumer.service.js';

@Injectable()
export class WagerSqsRuntimeService
  implements BeforeApplicationShutdown
{
  private client?: SQSClient;

  private consumer?:
    WagerSqsConsumerService;

  private started = false;

  constructor(
    private readonly processWagerService:
      ProcessWagerService,

    private readonly observability:
      ObservabilityService,
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

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

    const dlqUrl =
      await this.ensureQueue(
        process.env
          .SQS_WAGER_DLQ_NAME ??
          'wager-transactions-dlq.fifo',
      );

    const queueUrl =
      await this.ensureQueue(
        process.env
          .SQS_WAGER_QUEUE_NAME ??
          'wager-transactions.fifo',
      );

    this.consumer =
      new WagerSqsConsumerService(
        this.client,
        queueUrl,
        this.processWagerService,
        dlqUrl,
        this.readMaxAttempts(),
        this.observability,
      );

    this.consumer.start();

    this.started =
      true;

    this.observability.info(
      'sqs.runtime.started',
      {
        consumerName:
          'wager-transactions-consumer',
      },
    );
  }

  async beforeApplicationShutdown():
    Promise<void> {
    if (
      this.consumer
    ) {
      await this.consumer.stop();
    }

    if (
      this.client
    ) {
      this.client.destroy();
    }

    this.consumer =
      undefined;

    this.client =
      undefined;

    this.started =
      false;

    this.observability.info(
      'sqs.runtime.stopped',
      {
        consumerName:
          'wager-transactions-consumer',
      },
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

    if (
      !result.QueueUrl
    ) {
      throw new Error(
        `SQS_QUEUE_URL_MISSING:${queueName}`,
      );
    }

    return result.QueueUrl;
  }

  private readMaxAttempts():
    number {
    const rawValue =
      process.env
        .SQS_WAGER_MAX_ATTEMPTS ??
      '3';

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
        'SQS_WAGER_MAX_ATTEMPTS_MUST_BE_POSITIVE_INTEGER',
      );
    }

    return parsed;
  }
}