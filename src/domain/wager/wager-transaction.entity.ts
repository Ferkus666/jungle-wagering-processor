import {
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wager_transactions' })
@Unique({
  properties: [
    'providerId',
    'externalTransactionId',
  ],
})
@Index({
  properties: [
    'providerId',
    'referenceExternalTransactionId',
  ],
})
@Index({
  properties: [
    'providerId',
    'referenceTransactionId',
  ],
})
@Index({
  properties: [
    'status',
    'nextReferenceRetryAt',
  ],
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  /*
   * Identificador interno/público da
   * transação dentro da aplicação.
   */
  @Property({ type: 'string' })
  @Unique()
  transactionId!: string;

  /*
   * Provider que originou a operação.
   */
  @Property({ type: 'string' })
  providerId!: string;

  /*
   * Identificador da operação no provider.
   *
   * providerId + externalTransactionId
   * formam uma chave única.
   */
  @Property({ type: 'string' })
  externalTransactionId!: string;

  /*
   * Chave de idempotência usada para
   * processamento persistente.
   */
  @Property({ type: 'string' })
  idempotencyKey!: string;

  @Property({
    type: 'string',
    length: 64,
  })
  payloadHash!: string;

  /*
   * Contexto financeiro.
   */
  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'string' })
  playerId!: string;

  @Property({ type: 'string' })
  roundId!: string;

  @Property({ type: 'string' })
  gameId!: string;

  @Property({ type: 'string' })
  type!: string;

  /*
   * Dinheiro é armazenado como DECIMAL
   * no PostgreSQL e string no TypeScript.
   */
  @Property({
    type: 'decimal',
    precision: 18,
    scale: 2,
    runtimeType: 'string',
  })
  amount!: string;

  @Property({
    type: 'string',
    length: 3,
  })
  currency!: string;

  @Property({ type: 'string' })
  status!: string;

  /*
   * ID EXTERNO da transação referenciada,
   * exatamente como recebido do provider.
   *
   * REFUND e ROLLBACK usam este campo
   * para localizar a referência por:
   *
   * providerId + referenceExternalTransactionId
   */
  @Property({
    type: 'string',
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  /*
   * ID INTERNO da transação referenciada.
   *
   * Só é preenchido depois que a
   * referência externa foi encontrada e
   * validada (ver ProcessWagerService.validateReferenceMatch).
   */
  @Property({
    type: 'string',
    nullable: true,
  })
  referenceTransactionId?: string;

  @Property({
    type: 'string',
    nullable: true,
  })
  failureCode?: string;

  /*
   * ------------------------------------------------
   * PENDING REFERENCE RETRY
   * ------------------------------------------------
   *
   * Estado persistente do retry.
   *
   * Reiniciar uma instância não perde:
   *
   * - número de tentativas
   * - próximo horário de tentativa
   */
  @Property({
    type: 'integer',
    default: 0,
  })
  referenceRetryCount = 0;

  @Property({
    type: 'datetime',
    nullable: true,
  })
  nextReferenceRetryAt?: Date;

  /*
   * Momento em que a operação chegou
   * a um estado terminal:
   *
   * PROCESSED
   * REJECTED
   * FAILED
   */
  @Property({
    type: 'datetime',
    nullable: true,
  })
  processedAt?: Date;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Property({
    type: 'datetime',
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date();
}