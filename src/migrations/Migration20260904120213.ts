import { Migration } from '@mikro-orm/migrations';

export class Migration20260904120213 extends Migration {

  override name = 'Migration20260904120213';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "reference_retry_count" int not null default 0, add "next_reference_retry_at" timestamptz null, add "processed_at" timestamptz null;`);
    this.addSql(`create index "wager_transactions_status_next_reference_retry_at_index" on "wager_transactions" ("status", "next_reference_retry_at");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "wager_transactions_status_next_reference_retry_at_index";`);
    this.addSql(`alter table "wager_transactions" drop column "reference_retry_count", drop column "next_reference_retry_at", drop column "processed_at";`);
  }

}
