import { Migration } from '@mikro-orm/migrations';

export class Migration20260903023630 extends Migration {

  override name = 'Migration20260903023630';

  override up(): void | Promise<void> {
    this.addSql(`create table "idempotency_records" ("id" uuid not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(64) not null, "status" varchar(255) not null, "response_body" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "idempotency_records" add constraint "idempotency_records_idempotency_key_unique" unique ("idempotency_key");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "idempotency_records" cascade;`);
  }

}
