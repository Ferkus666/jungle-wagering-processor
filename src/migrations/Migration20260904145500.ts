import { Migration } from '@mikro-orm/migrations';

export class Migration20260904145500 extends Migration {
  override name =
    'Migration20260904145500';

  override up(): void | Promise<void> {
    /*
     * Cria o campo correto para guardar
     * exclusivamente a referência externa
     * recebida do provider.
     */
    this.addSql(`
      alter table "wager_transactions"
      add column "reference_external_transaction_id" varchar(255);
    `);

    /*
     * Na versão anterior do sistema,
     * reference_transaction_id guardava
     * justamente o ID externo.
     *
     * Copiamos os valores existentes para
     * a nova coluna sem apagar o campo
     * antigo neste momento.
     *
     * Isso mantém a migration segura para
     * dados já existentes.
     */
    this.addSql(`
      update "wager_transactions"
      set "reference_external_transaction_id" =
        "reference_transaction_id"
      where "reference_transaction_id" is not null;
    `);

    /*
     * A resolução da referência ocorre por:
     *
     * providerId +
     * referenceExternalTransactionId
     */
    this.addSql(`
      create index
      "wager_transactions_provider_reference_external_idx"
      on "wager_transactions"
      (
        "provider_id",
        "reference_external_transaction_id"
      );
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      drop index if exists
      "wager_transactions_provider_reference_external_idx";
    `);

    this.addSql(`
      alter table "wager_transactions"
      drop column "reference_external_transaction_id";
    `);
  }
}