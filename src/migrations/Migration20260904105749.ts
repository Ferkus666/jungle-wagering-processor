import { Migration } from '@mikro-orm/migrations';

export class Migration20260904105749 extends Migration {
  override name =
    'Migration20260904105749';

  override up(): void | Promise<void> {
    this.addSql(`
      create unique index
        "wager_transactions_unique_processed_reversal"
      on "wager_transactions"
        (
          "provider_id",
          "reference_transaction_id",
          "type"
        )
      where
        "reference_transaction_id" is not null
        and "status" = 'PROCESSED'
        and "type" in ('REFUND', 'ROLLBACK');
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      drop index
        "wager_transactions_unique_processed_reversal";
    `);
  }
}