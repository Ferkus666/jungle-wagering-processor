import { Migration } from '@mikro-orm/migrations';

export class Migration20260904114703 extends Migration {

  override name = 'Migration20260904114703';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("id" uuid not null, "consumer_name" varchar(255) not null, "message_id" varchar(255) not null, "payload_hash" varchar(64) not null, "received_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "inbox_messages_processed_at_index" on "inbox_messages" ("processed_at");`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_consumer_name_message_id_unique" unique ("consumer_name", "message_id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
  }

}
