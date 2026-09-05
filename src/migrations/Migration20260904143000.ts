import { Migration } from '@mikro-orm/migrations';

export class Migration20260904143000 extends Migration {
  override name = 'Migration20260904143000';

  override up(): void | Promise<void> {
    this.addSql(`
      alter table "wallet_ledger_entries"
      add column "direction" varchar(10),
      add column "balance_before" numeric(18,2),
      add column "balance_after" numeric(18,2);
    `);

    this.addSql(`
      with reconstructed as (
        select
          "id",
          "amount" as signed_amount,
          sum("amount") over (
            partition by "wallet_id"
            order by "created_at", "id"
            rows between unbounded preceding and current row
          ) as running_balance
        from "wallet_ledger_entries"
      )
      update "wallet_ledger_entries" ledger
      set
        "direction" = case
          when reconstructed.signed_amount < 0 then 'DEBIT'
          else 'CREDIT'
        end,
        "balance_after" = reconstructed.running_balance,
        "balance_before" = reconstructed.running_balance - reconstructed.signed_amount,
        "amount" = abs(reconstructed.signed_amount)
      from reconstructed
      where ledger."id" = reconstructed."id";
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      alter column "direction" set not null,
      alter column "balance_before" set not null,
      alter column "balance_after" set not null;
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      drop constraint "wallet_ledger_entries_transaction_id_entry_type_unique";
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_transaction_id_wallet_id_unique"
      unique ("transaction_id", "wallet_id");
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_direction_valid"
      check ("direction" in ('DEBIT', 'CREDIT'));
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_amount_positive"
      check ("amount" > 0);
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_balances_non_negative"
      check ("balance_before" >= 0 and "balance_after" >= 0);
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_balance_arithmetic"
      check (
        ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")
        or
        ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
      );
    `);

  }

  override down(): void | Promise<void> {
    this.addSql(`
      alter table "wallet_ledger_entries"
      drop constraint if exists "wallet_ledger_entries_balance_arithmetic",
      drop constraint if exists "wallet_ledger_entries_balances_non_negative",
      drop constraint if exists "wallet_ledger_entries_amount_positive",
      drop constraint if exists "wallet_ledger_entries_direction_valid",
      drop constraint if exists "wallet_ledger_entries_transaction_id_wallet_id_unique";
    `);

    this.addSql(`
      update "wallet_ledger_entries"
      set "amount" = case
        when "direction" = 'DEBIT' then -"amount"
        else "amount"
      end;
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      drop column "direction",
      drop column "balance_before",
      drop column "balance_after";
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_transaction_id_entry_type_unique"
      unique ("transaction_id", "entry_type");
    `);
  }
}
