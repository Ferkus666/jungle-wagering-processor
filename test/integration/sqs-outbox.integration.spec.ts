import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { randomUUID } from 'node:crypto';

import { OutboxEventEntity } from '../../src/infrastructure/outbox/outbox-event.entity.js';
import { SqsOutboxTransport } from '../../src/infrastructure/sqs/sqs-outbox.transport.js';

describe(
  'SqsOutboxTransport - integration',
  () => {
    let client: SQSClient;

    let queueUrl: string;

    const queueName =
      'integration-events.fifo';

    beforeAll(async () => {
      client =
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
              'test',

            secretAccessKey:
              'test',
          },
        });

      await client.send(
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

      const queueResult =
        await client.send(
          new GetQueueUrlCommand({
            QueueName:
              queueName,
          }),
        );

      if (!queueResult.QueueUrl) {
        throw new Error(
          'SQS queue URL was not returned',
        );
      }

      queueUrl =
        queueResult.QueueUrl;

      /*
       * Esvazia mensagens antigas
       * eventualmente deixadas por
       * execuções anteriores.
       */
      while (true) {
        const result =
          await client.send(
            new ReceiveMessageCommand({
              QueueUrl:
                queueUrl,

              MaxNumberOfMessages:
                10,

              WaitTimeSeconds:
                0,

              VisibilityTimeout:
                1,
            }),
          );

        const messages =
          result.Messages ?? [];

        if (
          messages.length === 0
        ) {
          break;
        }

        for (
          const message
          of messages
        ) {
          if (
            message.ReceiptHandle
          ) {
            await client.send(
              new DeleteMessageCommand({
                QueueUrl:
                  queueUrl,

                ReceiptHandle:
                  message.ReceiptHandle,
              }),
            );
          }
        }
      }
    });

    afterAll(async () => {
      client.destroy();
    });

    test(
      'publishes outbox event to real FIFO SQS queue',
      async () => {
        const event =
          new OutboxEventEntity();

        event.id =
          randomUUID();

        event.eventType =
          'WagerTransactionProcessed.v1';

        event.aggregateType =
          'WagerTransaction';

        event.aggregateId =
          'internal-sqs-test-1';

        event.payload = {
          transactionId:
            'internal-sqs-test-1',

          providerId:
            'provider-a',

          externalTransactionId:
            'external-sqs-test-1',

          playerId:
            'player-sqs-test-1',

          walletId:
            'wallet-sqs-test-1',

          roundId:
            'round-sqs-test-1',

          gameId:
            'game-sqs-test-1',

          kind:
            'BET',

          money: {
            amount:
              '25.00',

            currency:
              'BRL',
          },

          status:
            'PROCESSED',
        };

        event.attempts =
          0;

        event.nextAttemptAt =
          new Date();

        event.createdAt =
          new Date();

        event.updatedAt =
          new Date();

        const transport =
          new SqsOutboxTransport(
            client,
            queueUrl,
          );

        await transport.publish(
          event,
        );

        const result =
          await client.send(
            new ReceiveMessageCommand({
              QueueUrl:
                queueUrl,

              MaxNumberOfMessages:
                1,

              WaitTimeSeconds:
                1,

              MessageAttributeNames: [
                'All',
              ],

              AttributeNames: [
                'All',
              ],
            }),
          );

        const message =
          result.Messages?.[0];

        expect(
          message,
        ).toBeDefined();

        expect(
          message?.Body,
        ).toBeDefined();

        const body =
          JSON.parse(
            message!.Body!,
          ) as {
            messageId: string;
            type: string;
            occurredAt: string;
            data: {
              transactionId: string;
              money: {
                amount: string;
                currency: string;
              };
            };
          };

        expect(
          body.messageId,
        ).toBe(event.id);

        expect(
          body.type,
        ).toBe(
          'WagerTransactionProcessed.v1',
        );

        expect(
          body.data.transactionId,
        ).toBe(
          'internal-sqs-test-1',
        );

        expect(
          body.data.money.amount,
        ).toBe('25.00');

        expect(
          body.data.money.currency,
        ).toBe('BRL');

        expect(
          message
            ?.MessageAttributes
            ?.eventType
            ?.StringValue,
        ).toBe(
          'WagerTransactionProcessed.v1',
        );

        if (
          message?.ReceiptHandle
        ) {
          await client.send(
            new DeleteMessageCommand({
              QueueUrl:
                queueUrl,

              ReceiptHandle:
                message.ReceiptHandle,
            }),
          );
        }
      },
    );
  },
);