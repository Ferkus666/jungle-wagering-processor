import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import {
  createHash,
  randomUUID,
} from 'node:crypto';

import { ProcessWagerService } from '../../application/wager/process-wager.service.js';

import type { ProcessWagerInput } from '../../application/wager/process-wager.input.js';

import {
  ObservabilityService,
} from '../observability/observability.service.js';

import type { WagerMessageEnvelope } from './wager-message.js';

export class WagerSqsConsumerService {
  private readonly consumerName =
    'wager-transactions-consumer';

  private stopping = false;

  private consumerLoop?: Promise<void>;

  constructor(
    private readonly client:
      SQSClient,

    private readonly queueUrl:
      string,

    private readonly processWagerService:
      ProcessWagerService,

    private readonly dlqUrl?:
      string,

    private readonly maxAttempts =
      3,

    /*
     * Opcional para preservar a
     * compatibilidade com testes que
     * instanciam o consumer manualmente.
     *
     * No runtime real o serviço é
     * fornecido pelo Nest.
     */
    private readonly observability?:
      ObservabilityService,
  ) {}

  start(): void {
    if (this.consumerLoop) {
      return;
    }

    this.stopping =
      false;

    this.observability?.info(
      'sqs.consumer.started',
      {
        consumerName:
          this.consumerName,
      },
    );

    this.consumerLoop =
      this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopping =
      true;

    this.observability?.info(
      'sqs.consumer.stopping',
      {
        consumerName:
          this.consumerName,
      },
    );

    if (
      this.consumerLoop
    ) {
      await this.consumerLoop;
    }

    this.consumerLoop =
      undefined;

    this.observability?.info(
      'sqs.consumer.stopped',
      {
        consumerName:
          this.consumerName,
      },
    );
  }

  private async runLoop():
    Promise<void> {
    while (
      !this.stopping
    ) {
      try {
        await this.consumeOne();
      } catch {
        /*
         * Um erro transitório não pode
         * encerrar permanentemente o
         * consumer.
         */
        if (
          this.stopping
        ) {
          return;
        }

        this.observability?.warn(
          'sqs.consumer.loop_retry',
          {
            consumerName:
              this.consumerName,
          },
        );

        await this.wait(
          250,
        );
      }
    }
  }

  async consumeOne():
    Promise<boolean> {
    if (
      this.stopping
    ) {
      return false;
    }

    const response =
      await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl:
            this.queueUrl,

          MaxNumberOfMessages:
            1,

          WaitTimeSeconds:
            1,

          VisibilityTimeout:
            2,

          AttributeNames: [
            'All',
          ],

          MessageAttributeNames: [
            'All',
          ],
        }),
      );

    const message =
      response.Messages?.[0];

    if (!message) {
      return false;
    }

    const receiptHandle =
      message.ReceiptHandle;

    if (!receiptHandle) {
      throw new Error(
        'SQS_RECEIPT_HANDLE_MISSING',
      );
    }

    const receiveCount =
      Number(
        message.Attributes
          ?.ApproximateReceiveCount ??
          '1',
      );

    /*
     * Estes campos começam indefinidos
     * porque uma mensagem inválida pode
     * falhar antes mesmo de conseguirmos
     * extrair os dados de negócio.
     */
    let envelope:
      | WagerMessageEnvelope
      | undefined;

    let transactionId:
      | string
      | undefined;

    const sqsMessageId =
      message.MessageId;

    const startedAt =
      performance.now();

    try {
      if (!message.Body) {
        throw new Error(
          'INVALID_SQS_MESSAGE_BODY',
        );
      }

      const inboxPayloadHash =
        createHash(
          'sha256',
        )
          .update(
            message.Body,
          )
          .digest('hex');

      envelope =
        this.parseMessage(
          message.Body,
        );

      transactionId =
        randomUUID();

      /*
       * Para mensagens SQS usamos o
       * messageId do envelope como
       * correlationId.
       *
       * Assim todos os logs relativos à
       * mesma entrega podem ser
       * correlacionados.
       */
      const correlationId =
        envelope.messageId;

      this.observability?.info(
        'sqs.wager.processing.started',
        {
          correlationId,

          messageId:
            envelope.messageId,

          transactionId,

          walletId:
            envelope.data
              .walletId,

          providerId:
            envelope.data
              .providerId,

          retryCount:
            Math.max(
              receiveCount - 1,
              0,
            ),
        },
      );

      const input:
        ProcessWagerInput =
        {
          transactionId,

          idempotencyKey:
            envelope.data
              .idempotencyKey,

          providerId:
            envelope.data
              .providerId,

          externalTransactionId:
            envelope.data
              .externalTransactionId,

          playerId:
            envelope.data
              .playerId,

          walletId:
            envelope.data
              .walletId,

          roundId:
            envelope.data
              .roundId,

          gameId:
            envelope.data
              .gameId,

          type:
            envelope.data
              .kind,

          amount:
            envelope.data
              .money
              .amount,

          currency:
            envelope.data
              .money
              .currency,

          referenceExternalTransactionId:
            envelope.data
              .referenceExternalTransactionId,
        };

      /*
       * O mesmo use case utilizado pelo
       * HTTP é reutilizado pelo consumer.
       *
       * Inbox + processamento financeiro +
       * ledger + outbox ficam dentro da
       * mesma transação de banco.
       */
      const result =
        await this
          .processWagerService
          .execute(
            input,
            {
              inbox: {
                consumerName:
                  this.consumerName,

                messageId:
                  envelope.messageId,

                payloadHash:
                  inboxPayloadHash,
              },
            },
          );

      const durationMs =
        performance.now() -
        startedAt;

      /*
       * Quando o Inbox já possui a mensagem como
       * processada, ProcessWagerService retorna
       * undefined de propósito.
       *
       * Esse é o cenário esperado quando ocorre:
       *
       * COMMIT no PostgreSQL
       *        ↓
       * processo cai antes do ACK
       *        ↓
       * SQS entrega novamente
       *        ↓
       * Inbox detecta duplicata
       *        ↓
       * não processa financeiramente de novo
       *        ↓
       * ACK seguro da nova entrega
       *
       * Portanto undefined aqui NÃO é falha.
       */
      if (!result) {
        this.observability
          ?.incrementCounter(
            'wager_duplicates_total',
            {
              source:
                'SQS_INBOX',
            },
          );

        this.observability
          ?.observeLatency(
            'wager_processing_duration_ms',
            durationMs,
            {
              source:
                'SQS',

              result:
                'DUPLICATE',
            },
          );

        this.observability?.info(
          'sqs.wager.duplicate_inbox',
          {
            correlationId,

            messageId:
              envelope.messageId,

            transactionId,

            walletId:
              envelope.data
                .walletId,

            providerId:
              envelope.data
                .providerId,

            status:
              'DUPLICATE',

            durationMs,
          },
        );

        /*
         * O processamento original já foi
         * confirmado no banco. Agora podemos
         * reconhecer com segurança a reentrega.
         */
        await this.deleteMessage(
          receiptHandle,
        );

        this.observability?.info(
          'sqs.message.acknowledged',
          {
            correlationId,

            messageId:
              envelope.messageId,

            transactionId,

            walletId:
              envelope.data
                .walletId,

            providerId:
              envelope.data
                .providerId,

            status:
              'DUPLICATE',
          },
        );

        return true;
      }

      this.observability
        ?.incrementCounter(
          'wager_transactions_total',
          {
            status:
              result.status,
          },
        );

      if (
        result.idempotentReplay
      ) {
        this.observability
          ?.incrementCounter(
            'wager_duplicates_total',
            {
              source:
                'SQS',
            },
          );
      }

      this.observability
        ?.observeLatency(
          'wager_processing_duration_ms',
          durationMs,
          {
            source:
              'SQS',

            result:
              result.status,
          },
        );

      this.observability?.info(
        'sqs.wager.processing.completed',
        {
          correlationId,

          messageId:
            envelope.messageId,

          transactionId:
            result.transactionId,

          walletId:
            envelope.data
              .walletId,

          providerId:
            envelope.data
              .providerId,

          status:
            result.status,

          idempotentReplay:
            result.idempotentReplay,

          durationMs,
        },
      );

      /*
       * ACK somente depois que execute()
       * terminou com sucesso.
       */
      await this.deleteMessage(
        receiptHandle,
      );

      this.observability?.info(
        'sqs.message.acknowledged',
        {
          correlationId,

          messageId:
            envelope.messageId,

          transactionId:
            result.transactionId,

          walletId:
            envelope.data
              .walletId,

          providerId:
            envelope.data
              .providerId,
        },
      );

      return true;
    } catch (error) {
      const durationMs =
        performance.now() -
        startedAt;

      const correlationId =
        envelope?.messageId ??
        sqsMessageId ??
        randomUUID();

      const errorMessage =
        error instanceof Error
          ? error.message
          : 'UNKNOWN_ERROR';

      /*
       * Erro permanente de formato.
       *
       * Repetir a mesma mensagem não
       * resolveria o problema.
       */
      if (
        this.isPermanentError(
          error,
        )
      ) {
        this.observability?.warn(
          'sqs.message.permanent_failure',
          {
            correlationId,

            messageId:
              envelope?.messageId ??
              sqsMessageId,

            transactionId,

            walletId:
              envelope?.data
                .walletId,

            providerId:
              envelope?.data
                .providerId,

            failureCode:
              errorMessage,

            retryCount:
              Math.max(
                receiveCount - 1,
                0,
              ),

            durationMs,
          },
        );

        await this.moveToDlq(
          message.Body ?? '',
          message.MessageId ??
            randomUUID(),
        );

        this.observability
          ?.incrementCounter(
            'sqs_dlq_messages_total',
            {
              reason:
                'PERMANENT_ERROR',
            },
          );

        await this.deleteMessage(
          receiptHandle,
        );

        return true;
      }

      /*
       * Ainda existem tentativas.
       *
       * Não fazemos ACK. Quando o
       * VisibilityTimeout acabar o SQS
       * poderá entregar novamente.
       */
      if (
        receiveCount <
        this.maxAttempts
      ) {
        this.observability
          ?.incrementCounter(
            'sqs_retries_total',
            {
              consumer:
                this.consumerName,
            },
          );

        this.observability
          ?.observeLatency(
            'wager_processing_duration_ms',
            durationMs,
            {
              source:
                'SQS',

              result:
                'RETRY',
            },
          );

        this.observability?.warn(
          'sqs.message.retry_scheduled',
          {
            correlationId,

            messageId:
              envelope?.messageId ??
              sqsMessageId,

            transactionId,

            walletId:
              envelope?.data
                .walletId,

            providerId:
              envelope?.data
                .providerId,

            failureCode:
              errorMessage,

            retryCount:
              receiveCount,

            durationMs,
          },
        );

        throw error;
      }

      /*
       * Máximo de tentativas atingido.
       */
      this.observability?.error(
        'sqs.message.max_attempts_reached',
        {
          correlationId,

          messageId:
            envelope?.messageId ??
            sqsMessageId,

          transactionId,

          walletId:
            envelope?.data
              .walletId,

          providerId:
            envelope?.data
              .providerId,

          failureCode:
            errorMessage,

          retryCount:
            receiveCount,

          durationMs,
        },
      );

      await this.moveToDlq(
        message.Body ?? '',
        message.MessageId ??
          randomUUID(),
      );

      this.observability
        ?.incrementCounter(
          'sqs_dlq_messages_total',
          {
            reason:
              'MAX_ATTEMPTS',
          },
        );

      await this.deleteMessage(
        receiptHandle,
      );

      return true;
    }
  }

  private async deleteMessage(
    receiptHandle: string,
  ): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl:
          this.queueUrl,

        ReceiptHandle:
          receiptHandle,
      }),
    );
  }

  private async moveToDlq(
    body: string,
    sourceMessageId: string,
  ): Promise<void> {
    if (!this.dlqUrl) {
      throw new Error(
        'DLQ_URL_NOT_CONFIGURED',
      );
    }

    await this.client.send(
      new SendMessageCommand({
        QueueUrl:
          this.dlqUrl,

        MessageBody:
          body,

        MessageGroupId:
          sourceMessageId,

        MessageDeduplicationId:
          sourceMessageId,
      }),
    );
  }

  private isPermanentError(
    error: unknown,
  ): boolean {
    if (
      !(error instanceof Error)
    ) {
      return false;
    }

    if (
      error.message.startsWith(
        'INVALID_SQS_',
      )
    ) {
      return true;
    }

    return [
      'INBOX_MESSAGE_CONFLICT',
      'IDEMPOTENCY_KEY_CONFLICT',
    ].includes(
      error.message,
    );
  }

  private parseMessage(
    body: string,
  ): WagerMessageEnvelope {
    let parsed: unknown;

    try {
      parsed =
        JSON.parse(body);
    } catch {
      throw new Error(
        'INVALID_SQS_MESSAGE_JSON',
      );
    }

    if (
      !parsed ||
      typeof parsed !==
        'object'
    ) {
      throw new Error(
        'INVALID_SQS_MESSAGE',
      );
    }

    const envelope =
      parsed as Partial<WagerMessageEnvelope>;

    if (
      typeof envelope.messageId !==
        'string' ||
      envelope.messageId.length ===
        0
    ) {
      throw new Error(
        'INVALID_SQS_MESSAGE_ID',
      );
    }

    if (
      typeof envelope.type !==
        'string' ||
      envelope.type.length ===
        0
    ) {
      throw new Error(
        'INVALID_SQS_MESSAGE_TYPE',
      );
    }

    if (
      typeof envelope.occurredAt !==
        'string' ||
      envelope.occurredAt.length ===
        0
    ) {
      throw new Error(
        'INVALID_SQS_OCCURRED_AT',
      );
    }

    if (
      !envelope.data ||
      typeof envelope.data !==
        'object'
    ) {
      throw new Error(
        'INVALID_SQS_MESSAGE_DATA',
      );
    }

    const data =
      envelope.data;

    if (
      typeof data.providerId !==
        'string' ||
      typeof data.externalTransactionId !==
        'string' ||
      typeof data.idempotencyKey !==
        'string' ||
      typeof data.playerId !==
        'string' ||
      typeof data.walletId !==
        'string' ||
      typeof data.roundId !==
        'string' ||
      typeof data.gameId !==
        'string'
    ) {
      throw new Error(
        'INVALID_SQS_BUSINESS_DATA',
      );
    }

    if (
      data.kind !==
        'BET' &&
      data.kind !==
        'WIN' &&
      data.kind !==
        'LOSS' &&
      data.kind !==
        'REFUND' &&
      data.kind !==
        'ROLLBACK'
    ) {
      throw new Error(
        'INVALID_SQS_WAGER_KIND',
      );
    }

    if (
      !data.money ||
      typeof data.money !==
        'object' ||
      typeof data.money.amount !==
        'string' ||
      typeof data.money.currency !==
        'string'
    ) {
      throw new Error(
        'INVALID_SQS_MONEY',
      );
    }

    if (
      (
        data.kind ===
          'REFUND' ||
        data.kind ===
          'ROLLBACK'
      ) &&
      (
        typeof data
          .referenceExternalTransactionId !==
          'string' ||
        data
          .referenceExternalTransactionId
          .length === 0
      )
    ) {
      throw new Error(
        'INVALID_SQS_REFERENCE',
      );
    }

    return envelope as WagerMessageEnvelope;
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