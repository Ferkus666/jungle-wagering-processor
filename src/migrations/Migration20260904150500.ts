import { Migration } from '@mikro-orm/migrations';

export class Migration20260904150500 extends Migration {
  override name = 'Migration20260904150500';

  override up(): void | Promise<void> {
    this.addSql(`
      update "wager_transactions" child
      set "reference_transaction_id" = reference."transaction_id"
      from "wager_transactions" reference
      where
        child."reference_external_transaction_id" is not null
        and child."provider_id" = reference."provider_id"
        and child."reference_external_transaction_id" = reference."external_transaction_id";
    `);

    this.addSql(`
      update "wager_transactions" child
      set "reference_transaction_id" = null
      where
        child."reference_external_transaction_id" is not null
        and not exists (
          select 1
          from "wager_transactions" reference
          where
            reference."provider_id" = child."provider_id"
            and reference."external_transaction_id" = child."reference_external_transaction_id"
        );
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      update "wager_transactions"
      set "reference_transaction_id" = "reference_external_transaction_id"
      where "reference_external_transaction_id" is not null;
    `);
  }
}
