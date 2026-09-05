# Jungle Wagering Processor

Distributed wagering processor built with **Bun, TypeScript, NestJS, PostgreSQL, MikroORM and AWS SQS-compatible queues**.

The project focuses on financial correctness under concurrency, durable idempotency, immutable ledger accounting, asynchronous recovery and safe multi-instance processing.

## Main goals

The processor guarantees that:

- money is represented as exact decimal strings with two decimal places;
- a wallet never becomes negative;
- wallet balance changes and ledger entries are committed atomically;
- each wallet has a monotonic version that changes only when the balance changes;
- repeated requests with the same idempotency key do not apply the financial effect twice;
- reusing an idempotency key with a different payload is rejected;
- concurrent requests do not cause lost updates;
- REFUND and ROLLBACK reference the original provider transaction safely;
- missing reversal references can wait in `PENDING_REFERENCE` and be retried asynchronously;
- queue messages are acknowledged only after the database work is committed;
- outbox events are persisted in the same transaction as the business change;
- background workers are safe to run in more than one application instance.

## Stack

- Bun 1.x
- TypeScript with strict typing
- NestJS
- PostgreSQL 16
- MikroORM
- decimal.js
- AWS SDK for SQS
- MiniStack for local SQS-compatible infrastructure
- Docker Compose
- Bun Test

## Architecture

The project is split into domain, application and infrastructure responsibilities.

```text
HTTP / SQS
   |
   v
Application layer
   |
   v
ProcessWagerService
   |
   +--------------------+
   |                    |
   v                    v
Domain rules        PostgreSQL transaction
Money / Wallet      wallet + wager + ledger
WagerTransaction    idempotency + inbox + outbox
                        |
                        v
                   Transactional Outbox
                        |
                        v
                 Background Publisher
                        |
                        v
                     SQS FIFO
```

Main folders:

```text
src/
  application/
    health/
    observability/
    reconciliation/
    wager/
    wallet/

  domain/
    idempotency/
    ledger/
    money/
    wager/
    wallet/

  infrastructure/
    observability/
    outbox/
    sqs/

  migrations/
```

## Financial model

### Money

Financial values are never handled as JavaScript floating-point money values.

The API accepts values such as:

```json
{
  "amount": "25.00",
  "currency": "BRL"
}
```

Domain validation requires an exact decimal representation and currency consistency.

### Wallet

A wallet belongs to one player and one currency.

Important invariants:

- at most one wallet per player and currency;
- balance cannot become negative;
- version starts at `1`;
- version is incremented only when balance changes;
- each balance change must have a corresponding ledger entry.

### Ledger

The ledger is append-only from the application perspective.

A ledger entry records:

- direction (`CREDIT` or `DEBIT`);
- exact amount;
- currency;
- balance before;
- balance after;
- related wager transaction.

`LOSS` is a processed wagering transaction but does not change wallet balance, therefore it does not create a ledger entry.

## Wager transaction types

Supported external transaction kinds:

| Kind | Financial effect |
|---|---|
| `BET` | debit |
| `WIN` | credit |
| `LOSS` | no balance change |
| `REFUND` | credit of a referenced BET |
| `ROLLBACK` | inverse effect of a referenced BET, WIN or REFUND |

`OPENING` is internal and is created when a wallet starts with a non-zero balance. It cannot be submitted through HTTP or SQS.

Transaction statuses:

- `PENDING`
- `PENDING_REFERENCE`
- `PROCESSED`
- `REJECTED`
- `FAILED`

`PROCESSED`, `REJECTED` and `FAILED` are terminal.

## Reversal references

The project intentionally separates two identifiers:

- `referenceExternalTransactionId`: provider-facing external reference;
- `referenceTransactionId`: internal ID of the resolved original transaction.

For a REFUND or ROLLBACK, the processor first receives the external reference. After the referenced transaction is found and validated, its internal transaction ID is persisted.

Reference validation checks include provider, player, wallet, currency, round, type and exact amount.

If the original transaction has not arrived yet, the reversal can enter `PENDING_REFERENCE`.

## Pending reference recovery

`PendingReferenceWorkerService` periodically processes due pending reversals.

The worker:

- retries missing references with backoff;
- can be run concurrently by multiple instances;
- uses database row locking with `SKIP LOCKED`;
- resolves the reversal when the referenced transaction appears;
- rejects it with a stable failure code after the configured retry limit.

## Concurrency strategy

Financial correctness is enforced in PostgreSQL transactions.

Wallet mutation uses pessimistic database locking so concurrent balance changes for the same wallet are serialized.

The project also uses PostgreSQL advisory transaction locks where serialization is needed for durable idempotency and inbox processing.

Lock contention is observable through:

```text
lock_conflicts_total
```

A dedicated integration test intentionally creates a real advisory-lock conflict and proves that processing resumes safely after the lock is released.

## Idempotency

HTTP requests require:

```text
Idempotency-Key
```

Idempotency is persisted in PostgreSQL instead of being stored only in memory.

The processor stores a canonical payload hash together with the idempotency record.

Behavior:

- same key + same payload: safe replay;
- same key + different payload: conflict;
- multiple application instances: protected by the database.

## SQS processing

The application consumes wager commands from a FIFO queue.

Default local queues:

```text
wager-transactions.fifo
wager-transactions-dlq.fifo
wager-events.fifo
```

The queues are created automatically when the application starts.

Incoming message format:

```json
{
  "messageId": "provider-message-001",
  "type": "WagerTransactionRequested.v1",
  "occurredAt": "2026-09-05T00:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-001",
    "idempotencyKey": "provider-a:bet-001",
    "playerId": "player-001",
    "walletId": "wallet-uuid",
    "roundId": "round-001",
    "gameId": "game-001",
    "kind": "BET",
    "money": {
      "amount": "25.00",
      "currency": "BRL"
    }
  }
}
```

The consumer uses the same wagering use case used by HTTP.

A persistent inbox prevents the same queue message from applying its business effect twice, including crash-before-ACK scenarios.

Messages are deleted from the source queue only after committed processing.

Business-invalid messages and retry exhaustion are sent to the configured DLQ.

## Transactional Outbox

Domain events are written to PostgreSQL in the same transaction as the financial state change.

A separate publisher reads unpublished events using a multi-worker-safe strategy and sends them to `wager-events.fifo`.

Published events include:

```text
WagerTransactionProcessed.v1
WagerTransactionRejected.v1
WagerTransactionPendingReference.v1
WalletBalanceChanged.v1
```

This prevents a committed financial transaction from losing its corresponding integration event if the process crashes after the database commit.

## Observability

Logs are structured JSON and intentionally avoid logging complete financial payloads.

Relevant identifiers can include:

- `correlationId`
- `messageId`
- `transactionId`
- `walletId`
- `providerId`
- `failureCode`
- `retryCount`
- `durationMs`

Examples of collected metrics include:

```text
wager_transactions_total
wager_duplicates_total
wager_processing_duration_ms

sqs_retries_total
sqs_dlq_messages_total

outbox_events_published_total
outbox_retries_total
outbox_publish_duration_ms
outbox_lag_ms

pending_reference_retries_total
pending_reference_resolved_total
pending_reference_rejected_total

lock_conflicts_total
background_worker_errors_total
```

Current in-process metrics snapshot:

```http
GET /metrics
```

## Health checks

Liveness:

```http
GET /health/live
```

Readiness:

```http
GET /health/ready
```

Readiness checks dependencies needed by the application instead of reporting healthy only because the HTTP process is running.

## HTTP API

### Create wallet

```http
POST /wallets
Content-Type: application/json
```

Example:

```json
{
  "playerId": "player-001",
  "initialBalance": {
    "amount": "100.00",
    "currency": "BRL"
  }
}
```

### Get wallet

```http
GET /wallets/:id
```

### Get wallet ledger

```http
GET /wallets/:id/ledger?limit=20&cursor=...
```

Ledger pagination uses a cursor based on `createdAt + id` instead of OFFSET pagination.

### Process wager

```http
POST /wagering/transactions
Idempotency-Key: provider-a:bet-001
Content-Type: application/json
```

Example BET:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-001",
  "playerId": "player-001",
  "walletId": "wallet-uuid",
  "roundId": "round-001",
  "gameId": "game-001",
  "kind": "BET",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  }
}
```

Example REFUND:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "refund-001",
  "playerId": "player-001",
  "walletId": "wallet-uuid",
  "roundId": "round-001",
  "gameId": "game-001",
  "kind": "REFUND",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  },
  "referenceExternalTransactionId": "bet-001"
}
```

A reversal whose original transaction has not arrived yet can return as `PENDING_REFERENCE`.

### Query wager by internal ID

```http
GET /wagering/transactions/:id
```

### Query wager by provider reference

```http
GET /wagering/transactions/provider/:providerId/:externalTransactionId
```

### Reconcile wallet

Canonical endpoint:

```http
POST /wallets/:walletId/reconciliation
```

A compatibility alias is also available:

```http
GET /reconciliation/wallets/:walletId
```

Reconciliation independently rebuilds the wallet balance from ledger entries and reports whether the stored balance is consistent.

Architectural decisions, trade-offs and known limitations are documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Local setup

### Requirements

Install:

- Bun 1.x
- Docker
- Docker Compose

### 1. Install dependencies

```bash
bun install
```

### 2. Start PostgreSQL and MiniStack

```bash
docker compose up -d
```

Default local services:

```text
PostgreSQL: 127.0.0.1:55432
MiniStack:  http://localhost:4566
```

### 3. Configure environment

A minimal local `.env` can be:

```env
DATABASE_HOST=127.0.0.1
DATABASE_PORT=55432
DATABASE_NAME=jungle_wagering
DATABASE_USER=jungle
DATABASE_PASSWORD=jungle

AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
SQS_ENDPOINT=http://localhost:4566

SQS_WAGER_QUEUE_NAME=wager-transactions.fifo
SQS_WAGER_DLQ_NAME=wager-transactions-dlq.fifo
SQS_WAGER_EVENTS_QUEUE_NAME=wager-events.fifo
SQS_WAGER_MAX_ATTEMPTS=3

OUTBOX_POLL_INTERVAL_MS=500
OUTBOX_BATCH_SIZE=20

PENDING_REFERENCE_POLL_INTERVAL_MS=500
PENDING_REFERENCE_MAX_ATTEMPTS=5
PENDING_REFERENCE_BASE_BACKOFF_SECONDS=5

PORT=3000
```

### 4. Run migrations

```bash
bun run migration:up
```

### 5. Start application

Development:

```bash
bun run start:dev
```

Normal start:

```bash
bun run start
```

Production build:

```bash
bun run build
bun run start:prod
```

## Database migrations

Migrations are versioned under:

```text
src/migrations/
```

Apply:

```bash
bun run migration:up
```

Rollback the latest migration:

```bash
bun run migration:down
```

Create a new migration:

```bash
bun run migration:create
```

## Tests

Run all tests:

```bash
bun test
```

Build before submission:

```bash
bun run build
```

The test suite covers domain rules and PostgreSQL/SQS integration scenarios, including:

- exact Money behavior;
- Wallet invariants;
- wager state transitions;
- currency validation;
- durable idempotency;
- idempotency payload conflicts;
- HTTP processing;
- wallet and ledger endpoints;
- reconciliation;
- inbox crash recovery;
- outbox publishing;
- SQS retry and DLQ behavior;
- graceful consumer shutdown;
- pending-reference recovery;
- pending-reference observability;
- distributed wallet concurrency;
- lock-conflict observability;
- final wallet/ledger financial invariant.

### Concurrency scenario

An integration test starts with:

```text
balance = 100.00
```

and submits two concurrent BET transactions of:

```text
80.00 + 80.00
```

Expected result:

```text
one transaction processed
one transaction rejected for insufficient funds
final balance = 20.00
one debit applied
```

This demonstrates that the implementation does not rely on a single-process mutex.

### Final financial invariant

Another integration test executes a complete lifecycle:

```text
OPENING 100.00
BET      -25.00
WIN      +10.00
LOSS       0.00
REFUND   +25.00
ROLLBACK -10.00
----------------
FINAL    100.00
```

It verifies that:

- final wallet balance is `100.00`;
- wallet version changes only for balance-changing operations;
- LOSS creates no ledger entry;
- reversal references resolve to internal transaction IDs;
- each ledger `balanceBefore` matches the previous `balanceAfter`;
- the last ledger `balanceAfter` equals the persisted wallet balance;
- the ledger can independently reconstruct the wallet balance.

## Graceful shutdown

Nest shutdown hooks are enabled.

On `SIGTERM` or `SIGINT`:

- the SQS consumer stops receiving new work;
- background loops stop starting new cycles;
- in-flight work is awaited;
- SQS clients are destroyed only after worker shutdown.

## Multi-instance safety

The design avoids relying on process-local state for correctness.

Cross-instance coordination is provided by PostgreSQL through:

- database transactions;
- pessimistic wallet row locks;
- advisory transaction locks;
- unique constraints;
- persistent idempotency records;
- persistent inbox records;
- `FOR UPDATE SKIP LOCKED` background worker selection;
- transactional outbox state.

This makes the financial rules safe when several application instances receive work concurrently.

## Clean-start verification

To validate the project from a clean local environment:

```bash
docker compose down -v
docker compose up -d
bun install
bun run migration:up
bun run build
bun test
bun run start
```

After startup, verify:

```text
GET http://localhost:3000/health/live
GET http://localhost:3000/health/ready
GET http://localhost:3000/metrics
```

## Design trade-offs

### PostgreSQL as the coordination authority

Correctness is coordinated in PostgreSQL rather than with an in-memory mutex. An in-memory lock would protect only one application process and would fail as soon as multiple instances were deployed.

### Pessimistic wallet locking

Wallet mutations serialize at the wallet row. This favors financial correctness and simple invariants over maximum parallelism for commands targeting the same wallet, while unrelated wallets can still process concurrently.

### Persistent idempotency and inbox

Both HTTP idempotency and queue deduplication survive process restarts. A memory-only cache would not protect against retries after a crash.

### Transactional outbox

External publication is intentionally decoupled from the financial database transaction. The database commits the business change and event intent atomically; asynchronous delivery is retried independently.

### In-process metrics

For the challenge, metrics are exposed as an in-process snapshot at `/metrics`. In a production environment this service could be adapted to Prometheus/OpenTelemetry without changing the business model.

### Manual queue failure handling

The consumer explicitly distinguishes retryable failures, permanent-invalid messages and retry exhaustion. Failed messages can be forwarded to the configured DLQ while preserving the same processing use case.

## Submission checklist

Before submitting:

```bash
bun run build
bun test
```

Recommended clean run:

```bash
docker compose down -v
docker compose up -d
bun run migration:up
bun run build
bun test
```

The repository should not depend on previously created database state or manually created SQS queues.
