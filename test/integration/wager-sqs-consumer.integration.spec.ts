import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import {
  MikroORM,
  PostgreSqlDriver,
} from '@mikro-orm/postgresql';

import { randomUUID } from 'node:crypto';

import { WalletEntity } from '../../src/domain/wallet/wallet.entity.js';
import { LedgerEntryEntity } from '../../src/domain/ledger/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../src/domain/wager/wager-transaction.entity.js';
import { IdempotencyRecordEntity } from '../../src/domain/idempotency/idempotency-record.entity.js';

import { InboxMessageEntity } from '../../src/infrastructure/inbox/inbox-message.entity.js';
import { OutboxEventEntity } from '../../src/infrastructure/outbox/outbox-event.entity.js';

import { ProcessWagerService } from '../../src/application/wager/process-wager.service.js';

import { WagerSqsConsumerService } from '../../src/infrastructure/sqs/wager-sqs-consumer.service.js';
import { ObservabilityService } from '../../src/infrastructure/observability/observability.service.js';

describe(
  'WagerSqsConsumerService - integration',
  () => {
    let orm:
      MikroORM<PostgreSqlDriver>;

    let client:
      SQSClient;

    let queueUrl:
      string;

    let dlqUrl:
      string;

    const queueName =
      'wager-transactions.fifo';

    const dlqName =
      'wager-transactions-dlq.fifo';

    beforeAll(async () => {
      orm =
        await MikroORM.init<PostgreSqlDriver>({
          driver:
            PostgreSqlDriver,

          host:
            process.env
              .DATABASE_HOST ??
            '127.0.0.1',

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
            WalletEntity,
            LedgerEntryEntity,
            WagerTransactionEntity,
            IdempotencyRecordEntity,
            InboxMessageEntity,
            OutboxEventEntity,
          ],

          debug:
            false,
        });

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

      await client.send(
        new CreateQueueCommand({
          QueueName:
            dlqName,

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

      const dlqResult =
        await client.send(
          new GetQueueUrlCommand({
            QueueName:
              dlqName,
          }),
        );

      if (
        !queueResult.QueueUrl ||
        !dlqResult.QueueUrl
      ) {
        throw new Error(
          'SQS_QUEUE_URL_NOT_RETURNED',
        );
      }

      queueUrl =
        queueResult.QueueUrl;

      dlqUrl =
        dlqResult.QueueUrl;
    });

    beforeEach(
      async () => {
        const em =
          orm.em.fork();

        await em.nativeDelete(
          OutboxEventEntity,
          {},
        );

        await em.nativeDelete(
          InboxMessageEntity,
          {},
        );

        await em.nativeDelete(
          LedgerEntryEntity,
          {},
        );

        await em.nativeDelete(
          WagerTransactionEntity,
          {},
        );

        await em.nativeDelete(
          IdempotencyRecordEntity,
          {},
        );

        await em.nativeDelete(
          WalletEntity,
          {},
        );

        await clearQueue(
          queueUrl,
        );

        await clearQueue(
          dlqUrl,
        );
      },
    );

    afterAll(async () => {
      client.destroy();

      await orm.close(
        true,
      );
    });

    async function clearQueue(
      targetQueueUrl: string,
    ): Promise<void> {
      while (true) {
        const response =
          await client.send(
            new ReceiveMessageCommand({
              QueueUrl:
                targetQueueUrl,

              MaxNumberOfMessages:
                10,

              WaitTimeSeconds:
                0,

              VisibilityTimeout:
                1,
            }),
          );

        const messages =
          response.Messages ??
          [];

        if (
          messages.length ===
          0
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
                  targetQueueUrl,

                ReceiptHandle:
                  message.ReceiptHandle,
              }),
            );
          }
        }
      }
    }

    async function createWallet(
      playerId: string,
      balance = '100.00',
    ): Promise<string> {
      const em =
        orm.em.fork();

      const walletId =
        randomUUID();

      const wallet =
        em.create(
          WalletEntity,
          {
            id:
              walletId,

            playerId,

            currency:
              'BRL',

            balance,

            createdAt:
              new Date(),

            updatedAt:
              new Date(),
          },
        );

      em.persist(
        wallet,
      );

      await em.flush();

      return walletId;
    }

    test(
      'consumes real FIFO SQS message, commits financial transaction and acknowledges message',
      async () => {
        const playerId =
          'player-sqs-consumer';

        const walletId =
          await createWallet(
            playerId,
          );

        const messageId =
          randomUUID();

        const body =
          JSON.stringify({
            messageId,

            type:
              'WagerTransactionRequested.v1',

            occurredAt:
              new Date()
                .toISOString(),

            data: {
              providerId:
                'provider-a',

              externalTransactionId:
                'external-sqs-consumer-1',

              idempotencyKey:
                'provider-a:external-sqs-consumer-1',

              playerId,

              walletId,

              roundId:
                'round-sqs-consumer-1',

              gameId:
                'game-sqs-consumer-1',

              kind:
                'BET',

              money: {
                amount:
                  '25.00',

                currency:
                  'BRL',
              },
            },
          });

        await client.send(
          new SendMessageCommand({
            QueueUrl:
              queueUrl,

            MessageBody:
              body,

            MessageGroupId:
              walletId,

            MessageDeduplicationId:
              messageId,
          }),
        );

        const consumer =
          new WagerSqsConsumerService(
            client,

            queueUrl,

            new ProcessWagerService(
              orm.em.fork(),
            ),

            dlqUrl,
          );

        const consumed =
          await consumer.consumeOne();

        expect(
          consumed,
        ).toBe(true);

        const verificationEm =
          orm.em.fork();

        const wallet =
          await verificationEm.findOneOrFail(
            WalletEntity,
            {
              id:
                walletId,
            },
          );

        const inbox =
          await verificationEm.find(
            InboxMessageEntity,
            {
              messageId,
            },
          );

        const transactions =
          await verificationEm.find(
            WagerTransactionEntity,
            {
              externalTransactionId:
                'external-sqs-consumer-1',
            },
          );

        const ledger =
          await verificationEm.find(
            LedgerEntryEntity,
            {
              walletId,
            },
          );

        const outbox =
          await verificationEm.find(
            OutboxEventEntity,
            {},
          );

        expect(
          wallet.balance,
        ).toBe(
          '75.00',
        );

        expect(
          inbox,
        ).toHaveLength(
          1,
        );

        expect(
          inbox[0]
            ?.processedAt,
        ).not.toBeNull();

        expect(
          transactions,
        ).toHaveLength(
          1,
        );

        expect(
          transactions[0]
            ?.status,
        ).toBe(
          'PROCESSED',
        );

        expect(
          ledger,
        ).toHaveLength(
          1,
        );

        expect(
          ledger[0]
            ?.amount,
        ).toBe(
          '25.00',
        );

        expect(
          outbox,
        ).toHaveLength(
          2,
        );

        const afterAck =
          await client.send(
            new ReceiveMessageCommand({
              QueueUrl:
                queueUrl,

              MaxNumberOfMessages:
                1,

              WaitTimeSeconds:
                1,
            }),
          );

        expect(
          afterAck.Messages ??
            [],
        ).toHaveLength(
          0,
        );
      },
    );

    test(
      'does not acknowledge transient failure before max attempts',
      async () => {
        const missingWalletId =
          randomUUID();

        const messageId =
          randomUUID();

        const body =
          JSON.stringify({
            messageId,

            type:
              'WagerTransactionRequested.v1',

            occurredAt:
              new Date()
                .toISOString(),

            data: {
              providerId:
                'provider-a',

              externalTransactionId:
                'external-sqs-transient-1',

              idempotencyKey:
                'provider-a:external-sqs-transient-1',

              playerId:
                'player-missing-wallet',

              walletId:
                missingWalletId,

              roundId:
                'round-transient-1',

              gameId:
                'game-transient-1',

              kind:
                'BET',

              money: {
                amount:
                  '25.00',

                currency:
                  'BRL',
              },
            },
          });

        await client.send(
          new SendMessageCommand({
            QueueUrl:
              queueUrl,

            MessageBody:
              body,

            MessageGroupId:
              missingWalletId,

            MessageDeduplicationId:
              messageId,
          }),
        );

        const consumer =
          new WagerSqsConsumerService(
            client,

            queueUrl,

            new ProcessWagerService(
              orm.em.fork(),
            ),

            dlqUrl,

            3,
          );

        await expect(
          consumer.consumeOne(),
        ).rejects.toThrow();

        const verificationEm =
          orm.em.fork();

        const inbox =
          await verificationEm.find(
            InboxMessageEntity,
            {
              messageId,
            },
          );

        expect(
          inbox,
        ).toHaveLength(
          0,
        );

        const dlqMessages =
          await client.send(
            new ReceiveMessageCommand({
              QueueUrl:
                dlqUrl,

              MaxNumberOfMessages:
                1,

              WaitTimeSeconds:
                0,
            }),
          );

        expect(
          dlqMessages.Messages ??
            [],
        ).toHaveLength(
          0,
        );
      },
    );

    test(
      'moves permanently invalid message directly to DLQ',
      async () => {
        const messageId =
          randomUUID();

        const invalidBody =
          JSON.stringify({
            messageId,

            type:
              'WagerTransactionRequested.v1',

            occurredAt:
              new Date()
                .toISOString(),

            data: {
              providerId:
                'provider-a',
            },
          });

        await client.send(
          new SendMessageCommand({
            QueueUrl:
              queueUrl,

            MessageBody:
              invalidBody,

            MessageGroupId:
              'invalid-message',

            MessageDeduplicationId:
              messageId,
          }),
        );

        const consumer =
          new WagerSqsConsumerService(
            client,

            queueUrl,

            new ProcessWagerService(
              orm.em.fork(),
            ),

            dlqUrl,
          );

        const consumed =
          await consumer.consumeOne();

        expect(
          consumed,
        ).toBe(true);

        const dlqResponse =
          await client.send(
            new ReceiveMessageCommand({
              QueueUrl:
                dlqUrl,

              MaxNumberOfMessages:
                1,

              WaitTimeSeconds:
                1,
            }),
          );

        expect(
          dlqResponse.Messages,
        ).toHaveLength(
          1,
        );

        expect(
          dlqResponse
            .Messages?.[0]
            ?.Body,
        ).toBe(
          invalidBody,
        );

        const mainQueueResponse =
          await client.send(
            new ReceiveMessageCommand({
              QueueUrl:
                queueUrl,

              MaxNumberOfMessages:
                1,

              WaitTimeSeconds:
                1,
            }),
          );

        expect(
          mainQueueResponse.Messages ??
            [],
        ).toHaveLength(
          0,
        );
      },
    );

    test(
      'records retry observability metric for transient SQS failure',
      async () => {
        const missingWalletId =
          randomUUID();

        const messageId =
          randomUUID();

        const body =
          JSON.stringify({
            messageId,

            type:
              'WagerTransactionRequested.v1',

            occurredAt:
              new Date()
                .toISOString(),

            data: {
              providerId:
                'provider-observability',

              externalTransactionId:
                'external-sqs-observability-retry',

              idempotencyKey:
                'provider-observability:external-sqs-observability-retry',

              playerId:
                'player-observability-missing-wallet',

              walletId:
                missingWalletId,

              roundId:
                'round-observability-retry',

              gameId:
                'game-observability-retry',

              kind:
                'BET',

              money: {
                amount:
                  '25.00',

                currency:
                  'BRL',
              },
            },
          });

        await client.send(
          new SendMessageCommand({
            QueueUrl:
              queueUrl,

            MessageBody:
              body,

            MessageGroupId:
              missingWalletId,

            MessageDeduplicationId:
              messageId,
          }),
        );

        const observability =
          new ObservabilityService();

        const consumer =
          new WagerSqsConsumerService(
            client,

            queueUrl,

            new ProcessWagerService(
              orm.em.fork(),
            ),

            dlqUrl,

            3,

            observability,
          );

        await expect(
          consumer.consumeOne(),
        ).rejects.toThrow();

        const snapshot =
          observability.snapshot();

        const retryCounter =
          snapshot.counters.find(
            (metric) =>
              metric.name ===
                'sqs_retries_total' &&
              metric.labels
                .consumer ===
                'wager-transactions-consumer',
          );

        expect(
          retryCounter?.value,
        ).toBe(
          1,
        );

        const retryLatency =
          snapshot.latencies.find(
            (metric) =>
              metric.name ===
                'wager_processing_duration_ms' &&
              metric.labels
                .source ===
                'SQS' &&
              metric.labels
                .result ===
                'RETRY',
          );

        expect(
          retryLatency?.count,
        ).toBe(
          1,
        );
      },
    );

    test(
      'records DLQ observability metric for permanently invalid SQS message',
      async () => {
        const messageId =
          randomUUID();

        const invalidBody =
          JSON.stringify({
            messageId,

            type:
              'WagerTransactionRequested.v1',

            occurredAt:
              new Date()
                .toISOString(),

            data: {
              providerId:
                'provider-observability',
            },
          });

        await client.send(
          new SendMessageCommand({
            QueueUrl:
              queueUrl,

            MessageBody:
              invalidBody,

            MessageGroupId:
              'observability-invalid-message',

            MessageDeduplicationId:
              messageId,
          }),
        );

        const observability =
          new ObservabilityService();

        const consumer =
          new WagerSqsConsumerService(
            client,

            queueUrl,

            new ProcessWagerService(
              orm.em.fork(),
            ),

            dlqUrl,

            3,

            observability,
          );

        const consumed =
          await consumer.consumeOne();

        expect(
          consumed,
        ).toBe(
          true,
        );

        const snapshot =
          observability.snapshot();

        const dlqCounter =
          snapshot.counters.find(
            (metric) =>
              metric.name ===
                'sqs_dlq_messages_total' &&
              metric.labels
                .reason ===
                'PERMANENT_ERROR',
          );

        expect(
          dlqCounter?.value,
        ).toBe(
          1,
        );

        const dlqResponse =
          await client.send(
            new ReceiveMessageCommand({
              QueueUrl:
                dlqUrl,

              MaxNumberOfMessages:
                1,

              WaitTimeSeconds:
                1,
            }),
          );

        expect(
          dlqResponse.Messages,
        ).toHaveLength(
          1,
        );
      },
    );

    test(
      'recovers safely when process crashes after database commit but before SQS acknowledgement',
      async () => {
        /*
         * Este cenário usa uma fila FIFO própria.
         *
         * O teste anterior de falha transitória
         * deixa propositalmente uma mensagem sem ACK.
         * Enquanto ela está invisível, uma limpeza por
         * ReceiveMessage não consegue removê-la.
         *
         * Usar uma fila isolada evita que essa mensagem
         * de outro cenário reapareça durante o teste de
         * crash/reentrega.
         */
        const crashQueueName =
          `wager-transactions-crash-${randomUUID()}.fifo`;

        const crashQueueResult =
          await client.send(
            new CreateQueueCommand({
              QueueName:
                crashQueueName,

              Attributes: {
                FifoQueue:
                  'true',

                ContentBasedDeduplication:
                  'false',
              },
            }),
          );

        const crashQueueUrl =
          crashQueueResult.QueueUrl;

        if (!crashQueueUrl) {
          throw new Error(
            'SQS_CRASH_TEST_QUEUE_URL_NOT_RETURNED',
          );
        }

        try {
          const playerId =
            `player-crash-${randomUUID()}`;

          const walletId =
            await createWallet(
              playerId,
            );

          const messageId =
            randomUUID();

          const externalTransactionId =
            `external-crash-${randomUUID()}`;

          const idempotencyKey =
            `provider-a:${externalTransactionId}`;

          const body =
            JSON.stringify({
              messageId,

              type:
                'WagerTransactionRequested.v1',

              occurredAt:
                new Date()
                  .toISOString(),

              data: {
                providerId:
                  'provider-a',

                externalTransactionId,

                idempotencyKey,

                playerId,

                walletId,

                roundId:
                  'round-crash-after-commit',

                gameId:
                  'game-crash-after-commit',

                kind:
                  'BET',

                money: {
                  amount:
                    '25.00',

                  currency:
                    'BRL',
                },
              },
            });

          await client.send(
            new SendMessageCommand({
              QueueUrl:
                crashQueueUrl,

              MessageBody:
                body,

              MessageGroupId:
                walletId,

              MessageDeduplicationId:
                messageId,
            }),
          );

          /*
           * Primeira instância:
           * recebe a mensagem, processa e COMMITA,
           * mas não envia DeleteMessage (simula crash).
           */
          const firstDelivery =
            await client.send(
              new ReceiveMessageCommand({
                QueueUrl:
                  crashQueueUrl,

                MaxNumberOfMessages:
                  1,

                WaitTimeSeconds:
                  1,

                VisibilityTimeout:
                  1,

                AttributeNames: [
                  'All',
                ],
              }),
            );

          expect(
            firstDelivery.Messages,
          ).toHaveLength(
            1,
          );

          expect(
            JSON.parse(
              firstDelivery.Messages?.[0]
                ?.Body ?? '{}',
            ).messageId,
          ).toBe(
            messageId,
          );

          const payloadHash =
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder()
                .encode(
                  body,
                ),
            );

          const payloadHashHex =
            Array.from(
              new Uint8Array(
                payloadHash,
              ),
            )
              .map(
                (
                  value,
                ) =>
                  value
                    .toString(
                      16,
                    )
                    .padStart(
                      2,
                      '0',
                    ),
              )
              .join('');

          await new ProcessWagerService(
            orm.em.fork(),
          ).execute(
            {
              transactionId:
                randomUUID(),

              idempotencyKey,

              providerId:
                'provider-a',

              externalTransactionId,

              playerId,

              walletId,

              roundId:
                'round-crash-after-commit',

              gameId:
                'game-crash-after-commit',

              type:
                'BET',

              amount:
                '25.00',

              currency:
                'BRL',
            },
            {
              inbox: {
                consumerName:
                  'wager-transactions-consumer',

                messageId,

                payloadHash:
                  payloadHashHex,
              },
            },
          );

          /*
           * Nada apaga a primeira entrega.
           * Após o visibility timeout, a mesma
           * mensagem deve ser entregue novamente.
           */
          await Bun.sleep(
            1200,
          );

          const secondConsumer =
            new WagerSqsConsumerService(
              client,

              crashQueueUrl,

              new ProcessWagerService(
                orm.em.fork(),
              ),

              dlqUrl,
            );

          const consumed =
            await secondConsumer
              .consumeOne();

          expect(
            consumed,
          ).toBe(
            true,
          );

          const verificationEm =
            orm.em.fork();

          const wallet =
            await verificationEm.findOneOrFail(
              WalletEntity,
              {
                id:
                  walletId,
              },
            );

          const transactions =
            await verificationEm.find(
              WagerTransactionEntity,
              {
                providerId:
                  'provider-a',

                externalTransactionId,
              },
            );

          const ledger =
            await verificationEm.find(
              LedgerEntryEntity,
              {
                walletId,
              },
            );

          const inbox =
            await verificationEm.find(
              InboxMessageEntity,
              {
                consumerName:
                  'wager-transactions-consumer',

                messageId,
              },
            );

          expect(
            wallet.balance,
          ).toBe(
            '75.00',
          );

          expect(
            transactions,
          ).toHaveLength(
            1,
          );

          expect(
            ledger,
          ).toHaveLength(
            1,
          );

          expect(
            ledger[0]
              ?.amount,
          ).toBe(
            '25.00',
          );

          expect(
            inbox,
          ).toHaveLength(
            1,
          );

          expect(
            inbox[0]
              ?.processedAt,
          ).not.toBeNull();

          const afterAck =
            await client.send(
              new ReceiveMessageCommand({
                QueueUrl:
                  crashQueueUrl,

                MaxNumberOfMessages:
                  1,

                WaitTimeSeconds:
                  1,
              }),
            );

          expect(
            afterAck.Messages ??
              [],
          ).toHaveLength(
            0,
          );
        } finally {
          await client.send(
            new DeleteQueueCommand({
              QueueUrl:
                crashQueueUrl,
            }),
          );
        }
      },
      10000,
    );

  },
);