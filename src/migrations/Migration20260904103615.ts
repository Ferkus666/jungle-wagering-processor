import { Migration } from '@mikro-orm/migrations';

export class Migration20260904103615 extends Migration {

  override name = 'Migration20260904103615';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "provider_id" varchar(255) not null, add "external_transaction_id" varchar(255) not null, add "idempotency_key" varchar(255) not null, add "payload_hash" varchar(64) not null, add "wallet_id" uuid not null, add "round_id" varchar(255) not null, add "game_id" varchar(255) not null;`);
    this.addSql(`create index "wager_transactions_provider_id_reference_transaction_id_index" on "wager_transactions" ("provider_id", "reference_transaction_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_id_external_transaction_id_unique" unique ("provider_id", "external_transaction_id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "wager_transactions_provider_id_reference_transaction_id_index";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_provider_id_external_transaction_id_unique";`);
    this.addSql(`alter table "wager_transactions" drop column "provider_id", drop column "external_transaction_id", drop column "idempotency_key", drop column "payload_hash", drop column "wallet_id", drop column "round_id", drop column "game_id";`);
  }

}
