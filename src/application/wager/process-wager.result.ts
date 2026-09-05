export interface ProcessWagerResult {
  transactionId: string;

  status: string;

  balance: {
    amount: string;
    currency: string;
  };

  idempotentReplay: boolean;

  failureCode?: string;
}
