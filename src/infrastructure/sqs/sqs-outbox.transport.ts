import {
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import type { OutboxEventEntity } from '../outbox/outbox-event.entity.js';
import type { OutboxTransport } from '../outbox/outbox-transport.js';

export class SqsOutboxTransport
  implements OutboxTransport
{
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(
    event: OutboxEventEntity,
  ): Promise<void> {
    const messageBody =
      JSON.stringify({
        messageId:
          event.id,

        type:
          event.eventType,

        occurredAt:
          event.createdAt.toISOString(),

        data:
          event.payload,
      });

    await this.client.send(
      new SendMessageCommand({
        QueueUrl:
          this.queueUrl,

        MessageBody:
          messageBody,

        MessageGroupId:
          `${event.aggregateType}:${event.aggregateId}`,

        MessageDeduplicationId:
          event.id,

        MessageAttributes: {
          eventType: {
            DataType:
              'String',

            StringValue:
              event.eventType,
          },

          aggregateType: {
            DataType:
              'String',

            StringValue:
              event.aggregateType,
          },

          aggregateId: {
            DataType:
              'String',

            StringValue:
              event.aggregateId,
          },
        },
      }),
    );
  }
}