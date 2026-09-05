import {
  describe,
  expect,
  test,
} from 'bun:test';

import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import type { ProcessWagerService } from '../../application/wager/process-wager.service.js';

import {
  WagerSqsConsumerService,
} from './wager-sqs-consumer.service.js';

describe(
  'WagerSqsConsumerService - graceful shutdown',
  () => {
    test(
      'finishes the current message and does not receive another message after stop',
      async () => {
        let receiveCount = 0;
        let deleteCount = 0;
        let executeCount = 0;

        let releaseProcessing:
          (() => void) | undefined;

        const processingBlocked =
          new Promise<void>(
            (resolve) => {
              releaseProcessing =
                resolve;
            },
          );

        let notifyProcessingStarted:
          (() => void) | undefined;

        const processingStarted =
          new Promise<void>(
            (resolve) => {
              notifyProcessingStarted =
                resolve;
            },
          );

        const messageBody =
          JSON.stringify({
            messageId:
              'message-1',

            type:
              'WAGER_RECEIVED',

            occurredAt:
              new Date().toISOString(),

            data: {
              idempotencyKey:
                'idempotency-1',

              providerId:
                'provider-1',

              externalTransactionId:
                'external-1',

              playerId:
                'player-1',

              walletId:
                'wallet-1',

              roundId:
                'round-1',

              gameId:
                'game-1',

              kind:
                'BET',

              money: {
                amount:
                  '10.00',

                currency:
                  'USD',
              },
            },
          });

        const fakeClient = {
          send: async (
            command: unknown,
          ): Promise<unknown> => {
            if (
              command instanceof
              ReceiveMessageCommand
            ) {
              receiveCount += 1;

              /*
               * A primeira leitura entrega
               * uma mensagem real.
               *
               * Se o consumer tentar fazer
               * outra leitura depois do
               * stop(), o contador revelará
               * o erro.
               */
              if (
                receiveCount ===
                1
              ) {
                return {
                  Messages: [
                    {
                      MessageId:
                        'sqs-message-1',

                      ReceiptHandle:
                        'receipt-1',

                      Body:
                        messageBody,

                      Attributes: {
                        ApproximateReceiveCount:
                          '1',
                      },
                    },
                  ],
                };
              }

              return {
                Messages: [],
              };
            }

            if (
              command instanceof
              DeleteMessageCommand
            ) {
              deleteCount += 1;

              return {};
            }

            throw new Error(
              'UNEXPECTED_SQS_COMMAND',
            );
          },
        };

        const fakeProcessWagerService = {
          execute: async () => {
            executeCount += 1;

            /*
             * Avisamos ao teste que o
             * processamento financeiro
             * realmente começou.
             */
            notifyProcessingStarted?.();

            /*
             * Mantemos a mensagem em
             * processamento até o teste
             * chamar releaseProcessing().
             */
            await processingBlocked;

            return {};
          },
        };

        const consumer =
          new WagerSqsConsumerService(
            fakeClient as unknown as SQSClient,

            'http://localhost/queue',

            fakeProcessWagerService as unknown as ProcessWagerService,

            'http://localhost/dlq',

            3,
          );

        consumer.start();

        /*
         * Só pedimos shutdown quando
         * temos certeza de que existe
         * uma mensagem sendo processada.
         */
        await processingStarted;

        const stopPromise =
          consumer.stop();

        /*
         * Neste ponto stopping=true,
         * mas execute() ainda está
         * propositalmente bloqueado.
         *
         * O stop() deve aguardar o
         * processamento atual.
         */
        await Promise.resolve();

        expect(
          executeCount,
        ).toBe(1);

        expect(
          receiveCount,
        ).toBe(1);

        expect(
          deleteCount,
        ).toBe(0);

        /*
         * Liberamos o processamento.
         */
        releaseProcessing?.();

        await stopPromise;

        /*
         * A mensagem atual terminou
         * normalmente e recebeu ACK.
         */
        expect(
          executeCount,
        ).toBe(1);

        expect(
          deleteCount,
        ).toBe(1);

        /*
         * Propriedade principal do teste:
         *
         * após o shutdown começar, o
         * consumer NÃO buscou outra
         * mensagem.
         */
        expect(
          receiveCount,
        ).toBe(1);
      },
    );

    test(
      'does not receive messages when consumeOne is called after stop',
      async () => {
        let receiveCount = 0;

        const fakeClient = {
          send: async (): Promise<unknown> => {
            receiveCount += 1;

            return {
              Messages: [],
            };
          },
        };

        const fakeProcessWagerService = {
          execute: async () => {
            throw new Error(
              'SHOULD_NOT_PROCESS',
            );
          },
        };

        const consumer =
          new WagerSqsConsumerService(
            fakeClient as unknown as SQSClient,

            'http://localhost/queue',

            fakeProcessWagerService as unknown as ProcessWagerService,

            'http://localhost/dlq',

            3,
          );

        /*
         * stop() antes de start() também
         * deve colocar o consumer em
         * estado de encerramento.
         */
        await consumer.stop();

        const consumed =
          await consumer.consumeOne();

        expect(
          consumed,
        ).toBe(false);

        expect(
          receiveCount,
        ).toBe(0);
      },
    );
  },
);


describe(
  'WagerSqsConsumerService - permanent errors',
  () => {
    function createConsumer() {
      const fakeClient = {
        send: async (): Promise<unknown> => ({
          Messages: [],
        }),
      };

      const fakeProcessWagerService = {
        execute: async () => ({}),
      };

      return new WagerSqsConsumerService(
        fakeClient as unknown as SQSClient,

        'http://localhost/queue',

        fakeProcessWagerService as unknown as ProcessWagerService,

        'http://localhost/dlq',

        3,
      );
    }

    function isPermanent(
      consumer: WagerSqsConsumerService,
      error: Error,
    ): boolean {
      const exposed =
        consumer as unknown as {
          isPermanentError(
            error: unknown,
          ): boolean;
        };

      return exposed.isPermanentError(
        error,
      );
    }

    test(
      'treats inbox payload conflict as permanent',
      () => {
        expect(
          isPermanent(
            createConsumer(),
            new Error(
              'INBOX_MESSAGE_CONFLICT',
            ),
          ),
        ).toBe(true);
      },
    );

    test(
      'treats idempotency payload conflict as permanent',
      () => {
        expect(
          isPermanent(
            createConsumer(),
            new Error(
              'IDEMPOTENCY_KEY_CONFLICT',
            ),
          ),
        ).toBe(true);
      },
    );

    test(
      'keeps infrastructure failures transient',
      () => {
        expect(
          isPermanent(
            createConsumer(),
            new Error(
              'DATABASE_UNAVAILABLE',
            ),
          ),
        ).toBe(false);
      },
    );
  },
);
