import type { OutboxEventEntity } from './outbox-event.entity.js';

export interface OutboxTransport {
  publish(
    event: OutboxEventEntity,
  ): Promise<void>;
}