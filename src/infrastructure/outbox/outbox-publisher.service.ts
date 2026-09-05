import { Injectable } from '@nestjs/common';
import {
  EntityManager,
} from '@mikro-orm/postgresql';

import { OutboxEventEntity } from './outbox-event.entity.js';
import type { OutboxTransport } from './outbox-transport.js';
import { ObservabilityService } from '../observability/observability.service.js';

interface OutboxIdRow {
  id: string;
}

@Injectable()
export class OutboxPublisherService {
  constructor(
    private readonly em: EntityManager,
    private readonly transport: OutboxTransport,
    private readonly observability?: ObservabilityService,
  ) {}

  async publishBatch(
    batchSize = 20,
  ): Promise<number> {
    return this.em.transactional(
      async (em) => {
        /*
         * FOR UPDATE SKIP LOCKED:
         *
         * se outra instância já estiver
         * processando determinado evento,
         * esta instância simplesmente pula
         * aquele registro.
         */
        const rows =
          await em.execute<OutboxIdRow[]>(
            `
              select "id"
              from "outbox_events"
              where
                "published_at" is null
                and "next_attempt_at" <= now()
              order by "created_at" asc
              for update skip locked
              limit ?
            `,
            [batchSize],
          );

        let publishedCount = 0;

        for (const row of rows) {
          const event =
            await em.findOneOrFail(
              OutboxEventEntity,
              {
                id: row.id,
              },
            );

          const startedAt =
            performance.now();

          try {
            /*
             * A publicação ocorre somente
             * depois que o evento já existe
             * na Outbox.
             *
             * Portanto, a transação financeira
             * que criou o evento já foi
             * confirmada anteriormente.
             */
            await this.transport.publish(
              event,
            );

            const durationMs =
              performance.now() -
              startedAt;

            event.publishedAt =
              new Date();

            publishedCount += 1;

            this.observability
              ?.incrementCounter(
                'outbox_events_published_total',
                {
                  eventType:
                    event.eventType,
                },
              );

            this.observability
              ?.observeLatency(
                'outbox_publish_duration_ms',
                durationMs,
                {
                  result:
                    'PUBLISHED',
                },
              );

            this.observability?.info(
              'outbox.event.published',
              {
                outboxEventId:
                  event.id,

                eventType:
                  event.eventType,

                aggregateId:
                  event.aggregateId,

                retryCount:
                  event.attempts,

                durationMs,
              },
            );
          } catch (error) {
            const durationMs =
              performance.now() -
              startedAt;

            event.attempts += 1;

            event.nextAttemptAt =
              this.calculateNextAttempt(
                event.attempts,
              );

            this.observability
              ?.incrementCounter(
                'outbox_retries_total',
                {
                  eventType:
                    event.eventType,
                },
              );

            this.observability
              ?.observeLatency(
                'outbox_publish_duration_ms',
                durationMs,
                {
                  result:
                    'RETRY',
                },
              );

            this.observability?.warn(
              'outbox.event.retry_scheduled',
              {
                outboxEventId:
                  event.id,

                eventType:
                  event.eventType,

                aggregateId:
                  event.aggregateId,

                retryCount:
                  event.attempts,

                failureCode:
                  error instanceof Error
                    ? error.message
                    : 'UNKNOWN_ERROR',

                durationMs,
              },
            );
          }
        }

        await em.flush();

        return publishedCount;
      },
    );
  }

  private calculateNextAttempt(
    attempts: number,
  ): Date {
    /*
     * Backoff exponencial:
     *
     * tentativa 1 → 2 segundos
     * tentativa 2 → 4 segundos
     * tentativa 3 → 8 segundos
     * ...
     *
     * limitado a 5 minutos.
     */
    const seconds =
      Math.min(
        2 ** attempts,
        300,
      );

    return new Date(
      Date.now() +
        seconds * 1000,
    );
  }
}