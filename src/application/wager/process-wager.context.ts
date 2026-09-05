export interface ProcessWagerInboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ProcessWagerContext {
  inbox?: ProcessWagerInboxContext;
}