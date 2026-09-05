import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  MikroORM,
  PostgreSqlDriver,
} from '@mikro-orm/postgresql';

import { randomUUID } from 'node:crypto';

import { OutboxEventEntity } from '../../src/infrastructure/outbox/outbox-event.entity.js';
import { OutboxPublisherService } from '../../src/infrastructure/outbox/outbox-publisher.service.js';

import type { OutboxTransport } from '../../src/infrastructure/outbox/outbox-transport.js';

class FakeOutboxTransport
  implements OutboxTransport
{
  readonly publishedIds: string[] =
    [];

  async publish(
    event: OutboxEventEntity,
  ): Promise<void> {
    await new Promise<void>(
      (resolve) => {
        setTimeout(resolve, 5);
      },
    );

    this.publishedIds.push(
      event.id,
    );
  }
}

class FailingOutboxTransport
  implements OutboxTransport
{
  async publish(
    _event: OutboxEventEntity,
  ): Promise<void> {
    throw new Error(
      'SIMULATED_PUBLISH_FAILURE',
    );
  }
}

describe(
  'OutboxPublisherService - integration',
  () => {
    let orm: MikroORM<PostgreSqlDriver>;

    beforeAll(async () => {
      orm =
        await MikroORM.init<PostgreSqlDriver>({
          driver:
            PostgreSqlDriver,

          host:
            process.env
              .DATABASE_HOST ??
            '127.0.0.1',

          port: Number(
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
            OutboxEventEntity,
          ],

          debug: false,
        });
    });

    beforeEach(async () => {
      const em =
        orm.em.fork();

      await em.nativeDelete(
        OutboxEventEntity,
        {},
      );
    });

    afterAll(async () => {
      await orm.close(true);
    });

    async function createOutboxEvents(
      quantity: number,
    ): Promise<string[]> {
      const em =
        orm.em.fork();

      const ids: string[] =
        [];

      for (
        let index = 0;
        index < quantity;
        index += 1
      ) {
        const id =
          randomUUID();

        ids.push(id);

        const event =
          em.create(
            OutboxEventEntity,
            {
              id,

              eventType:
                'TestEvent.v1',

              aggregateType:
                'TestAggregate',

              aggregateId:
                `aggregate-${index}`,

              payload: {
                index,
              },

              attempts:
                0,

              nextAttemptAt:
                new Date(),

              createdAt:
                new Date(),

              updatedAt:
                new Date(),
            },
          );

        em.persist(event);
      }

      await em.flush();

      return ids;
    }

    test(
      'allows two concurrent publishers without publishing the same event twice',
      async () => {
        const expectedIds =
          await createOutboxEvents(
            20,
          );

        const transport =
          new FakeOutboxTransport();

        const publisher1 =
          new OutboxPublisherService(
            orm.em.fork(),
            transport,
          );

        const publisher2 =
          new OutboxPublisherService(
            orm.em.fork(),
            transport,
          );

        const [
          publisher1Count,
          publisher2Count,
        ] =
          await Promise.all([
            publisher1.publishBatch(
              10,
            ),

            publisher2.publishBatch(
              10,
            ),
          ]);

        expect(
          publisher1Count +
            publisher2Count,
        ).toBe(20);

        expect(
          transport.publishedIds,
        ).toHaveLength(20);

        const uniquePublishedIds =
          new Set(
            transport.publishedIds,
          );

        expect(
          uniquePublishedIds.size,
        ).toBe(20);

        expect(
          [
            ...uniquePublishedIds,
          ].sort(),
        ).toEqual(
          [...expectedIds].sort(),
        );

        const verificationEm =
          orm.em.fork();

        const unpublished =
          await verificationEm.find(
            OutboxEventEntity,
            {
              publishedAt:
                null,
            },
          );

        expect(
          unpublished,
        ).toHaveLength(0);
      },
    );

    test(
      'keeps failed event unpublished and schedules retry',
      async () => {
        await createOutboxEvents(
          1,
        );

        const publisher =
          new OutboxPublisherService(
            orm.em.fork(),
            new FailingOutboxTransport(),
          );

        const publishedCount =
          await publisher.publishBatch(
            10,
          );

        expect(
          publishedCount,
        ).toBe(0);

        const verificationEm =
          orm.em.fork();

        const events =
          await verificationEm.find(
            OutboxEventEntity,
            {},
          );

        expect(events).toHaveLength(
          1,
        );

        const event =
          events[0];

        expect(event).toBeDefined();

        expect(
          event!.publishedAt,
        ).toBeNull();

        expect(
          event!.attempts,
        ).toBe(1);

        expect(
          event!.nextAttemptAt.getTime(),
        ).toBeGreaterThan(
          Date.now(),
        );
      },
    );
  },
);