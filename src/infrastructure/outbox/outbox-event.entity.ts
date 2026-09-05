import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({
  tableName: 'outbox_events',
})
@Index({
  properties: [
    'publishedAt',
    'nextAttemptAt',
  ],
})
export class OutboxEventEntity {
  @PrimaryKey({
    type: 'uuid',
  })
  id!: string;

  @Property({
    type: 'string',
  })
  eventType!: string;

  @Property({
    type: 'string',
  })
  aggregateType!: string;

  @Property({
    type: 'string',
  })
  aggregateId!: string;

  @Property({
    type: 'json',
  })
  payload!: Record<
    string,
    unknown
  >;

  @Property({
    type: 'int',
    default: 0,
  })
  attempts = 0;

  @Property({
    type: 'datetime',
  })
  nextAttemptAt: Date =
    new Date();

  @Property({
    type: 'datetime',
    nullable: true,
  })
  publishedAt?: Date;

  @Property({
    type: 'datetime',
  })
  createdAt: Date =
    new Date();

  @Property({
    type: 'datetime',
    onUpdate: () =>
      new Date(),
  })
  updatedAt: Date =
    new Date();
}