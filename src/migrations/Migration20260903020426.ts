import { Migration } from '@mikro-orm/migrations';

export class Migration20260903020426 extends Migration {

  override name = 'Migration20260903020426';

  override up(): void | Promise<void> {
    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "player_id" varchar(255) not null,
        "transaction_id" varchar(255) not null,
        "entry_type" varchar(255) not null,
        "currency" varchar(3) not null,
        "amount" numeric(18,2) not null,
        "created_at" timestamptz not null,
        primary key ("id")
      );
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_transaction_id_entry_type_unique"
      unique ("transaction_id", "entry_type");
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }

}