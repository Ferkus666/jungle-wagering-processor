import {
  Check,
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

export type LedgerDirection =
  | 'DEBIT'
  | 'CREDIT';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['transactionId', 'walletId'] })
@Check({
  name: 'wallet_ledger_entries_direction_valid',
  expression: `direction in ('DEBIT', 'CREDIT')`,
})
@Check({
  name: 'wallet_ledger_entries_amount_positive',
  expression: 'amount > 0',
})
@Check({
  name: 'wallet_ledger_entries_balances_non_negative',
  expression: 'balance_before >= 0 and balance_after >= 0',
})
@Check({
  name: 'wallet_ledger_entries_balance_arithmetic',
  expression: `(
    direction = 'CREDIT' and balance_after = balance_before + amount
  ) or (
    direction = 'DEBIT' and balance_after = balance_before - amount
  )`,
})
export class LedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'string' })
  playerId!: string;

  @Property({ type: 'string' })
  transactionId!: string;

  @Property({ type: 'string' })
  entryType!: string;

  @Property({ type: 'string' })
  direction!: LedgerDirection;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({
    type: 'decimal',
    precision: 18,
    scale: 2,
    runtimeType: 'string',
  })
  amount!: string;

  @Property({
    type: 'decimal',
    precision: 18,
    scale: 2,
    runtimeType: 'string',
  })
  balanceBefore!: string;

  @Property({
    type: 'decimal',
    precision: 18,
    scale: 2,
    runtimeType: 'string',
  })
  balanceAfter!: string;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();
}
