import type { WagerTransactionType } from '../../domain/wager/wager-transaction.js';

export interface ProcessWagerInput {
  idempotencyKey: string;

  /* Identificador interno da transacao dentro da aplicacao. */
  transactionId: string;

  providerId: string;
  externalTransactionId: string;

  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;

  type: WagerTransactionType;

  amount: string;
  currency: string;

  /* ID externo da transacao referenciada no provider. */
  referenceExternalTransactionId?: string;

  /*
   * Forma alternativa de informar a referencia externa de um
   * REFUND/ROLLBACK. Quando ambos os campos estao presentes,
   * referenceExternalTransactionId tem prioridade (ver ProcessWagerService.execute).
   */
  referenceTransactionId?: string;
}
