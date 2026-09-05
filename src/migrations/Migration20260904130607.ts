import { Migration } from '@mikro-orm/migrations';

export class Migration20260904130607 extends Migration {

  override name = 'Migration20260904130607';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wallets" add "version" int not null default 1;`);
    this.addSql(`alter table "wallets" add constraint "wallets_version_positive" check (version >= 1);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wallets" drop constraint "wallets_version_positive";`);
    this.addSql(`alter table "wallets" drop column "version";`);
  }

}
