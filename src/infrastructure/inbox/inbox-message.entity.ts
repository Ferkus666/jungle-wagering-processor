import {
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({
  tableName: 'inbox_messages',
})
@Unique({
  properties: [
    'consumerName',
    'messageId',
  ],
})
@Index({
  properties: [
    'processedAt',
  ],
})
export class InboxMessageEntity {
  @PrimaryKey({
    type: 'uuid',
  })
  id!: string;

  @Property({
    type: 'string',
  })
  consumerName!: string;

  @Property({
    type: 'string',
  })
  messageId!: string;

  @Property({
    type: 'string',
    length: 64,
  })
  payloadHash!: string;

  @Property({
    type: 'datetime',
  })
  receivedAt: Date =
    new Date();

  @Property({
    type: 'datetime',
    nullable: true,
  })
  processedAt?: Date;
}