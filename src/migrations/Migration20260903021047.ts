import { Migration } from '@mikro-orm/migrations';

export class Migration20260903021047 extends Migration {

  override name = 'Migration20260903021047';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" uuid not null, "transaction_id" varchar(255) not null, "player_id" varchar(255) not null, "type" varchar(255) not null, "amount" numeric(18,2) not null, "currency" varchar(3) not null, "status" varchar(255) not null, "reference_transaction_id" varchar(255) null, "failure_code" varchar(255) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_transaction_id_unique" unique ("transaction_id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
  }

}
