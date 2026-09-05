import { Migration } from '@mikro-orm/migrations';

export class Migration20260904110918 extends Migration {

  override name = 'Migration20260904110918';

  override up(): void | Promise<void> {
    this.addSql(`create table "outbox_events" ("id" uuid not null, "event_type" varchar(255) not null, "aggregate_type" varchar(255) not null, "aggregate_id" varchar(255) not null, "payload" jsonb not null, "attempts" int not null default 0, "next_attempt_at" timestamptz not null, "published_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "outbox_events_published_at_next_attempt_at_index" on "outbox_events" ("published_at", "next_attempt_at");`);

    this.addSql(`drop index "wager_transactions_unique_processed_reversal";`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "outbox_events" cascade;`);

    this.addSql(`create unique index "wager_transactions_unique_processed_reversal" on "wager_transactions" ("provider_id", "reference_transaction_id", "type") where (reference_transaction_id IS NOT NULL) AND ((status)::text = 'PROCESSED'::text) AND ((type)::text = ANY ((ARRAY['REFUND'::character varying, 'ROLLBACK'::character varying])::text[]));`);
  }

}
