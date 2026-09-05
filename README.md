# Jungle Wagering Processor

Processador distribuído de apostas desenvolvido com **Bun, TypeScript, NestJS, PostgreSQL, MikroORM e filas compatíveis com AWS SQS**.

O projeto tem foco em consistência financeira sob concorrência, idempotência durável, contabilização em ledger imutável, recuperação assíncrona e processamento seguro em múltiplas instâncias.

## Principais objetivos

O processador garante que:

- valores monetários são representados como strings decimais exatas com duas casas decimais;
- uma carteira nunca fica com saldo negativo;
- alterações de saldo e entradas do ledger são persistidas atomicamente;
- cada carteira possui uma versão monotônica que muda apenas quando o saldo é alterado;
- requisições repetidas com a mesma chave de idempotência não aplicam o efeito financeiro duas vezes;
- a reutilização de uma chave de idempotência com payload diferente é rejeitada;
- requisições concorrentes não causam perda de atualizações;
- `REFUND` e `ROLLBACK` referenciam com segurança a transação original do provedor;
- referências de reversão ausentes podem permanecer em `PENDING_REFERENCE` e ser reprocessadas de forma assíncrona;
- mensagens da fila recebem confirmação somente após o commit do trabalho no banco de dados;
- eventos de outbox são persistidos na mesma transação da alteração de negócio;
- workers em segundo plano podem ser executados com segurança em mais de uma instância da aplicação.

## Tecnologias

- Bun 1.x
- TypeScript com tipagem estrita
- NestJS
- PostgreSQL 16
- MikroORM
- decimal.js
- AWS SDK for SQS
- MiniStack para infraestrutura local compatível com SQS
- Docker Compose
- Bun Test

## Arquitetura

O projeto é dividido entre responsabilidades de domínio, aplicação e infraestrutura.

```text
HTTP / SQS
   |
   v
Camada de aplicação
   |
   v
ProcessWagerService
   |
   +--------------------+
   |                    |
   v                    v
Regras de domínio    Transação PostgreSQL
Money / Wallet      wallet + wager + ledger
WagerTransaction    idempotency + inbox + outbox
                        |
                        v
                   Transactional Outbox
                        |
                        v
                 Publicador em segundo plano
                        |
                        v
                     SQS FIFO
```

Principais pastas:

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

## Modelo financeiro

### Money

Valores financeiros nunca são tratados como valores monetários de ponto flutuante do JavaScript.

A API aceita valores como:

```json
{
  "amount": "25.00",
  "currency": "BRL"
}
```

A validação de domínio exige representação decimal exata e consistência de moeda.

### Carteira

Uma carteira pertence a um jogador e a uma moeda.

Invariantes importantes:

- no máximo uma carteira por jogador e moeda;
- o saldo não pode ficar negativo;
- a versão começa em `1`;
- a versão é incrementada apenas quando o saldo muda;
- cada alteração de saldo deve possuir uma entrada correspondente no ledger.

### Ledger

O ledger é somente de acréscimo (`append-only`) do ponto de vista da aplicação.

Uma entrada do ledger registra:

- direção (`CREDIT` ou `DEBIT`);
- valor exato;
- moeda;
- saldo anterior;
- saldo posterior;
- transação de aposta relacionada.

`LOSS` é uma transação de aposta processada, mas não altera o saldo da carteira e, portanto, não cria uma entrada no ledger.

## Tipos de transação de aposta

Tipos de transação externa suportados:

| Tipo | Efeito financeiro |
|---|---|
| `BET` | débito |
| `WIN` | crédito |
| `LOSS` | sem alteração de saldo |
| `REFUND` | crédito de um BET referenciado |
| `ROLLBACK` | efeito inverso de um BET, WIN ou REFUND referenciado |

`OPENING` é interno e é criado quando uma carteira começa com saldo diferente de zero. Não pode ser enviado por HTTP ou SQS.

Status das transações:

- `PENDING`
- `PENDING_REFERENCE`
- `PROCESSED`
- `REJECTED`
- `FAILED`

`PROCESSED`, `REJECTED` e `FAILED` são estados terminais.

## Referências de reversão

O projeto separa intencionalmente dois identificadores:

- `referenceExternalTransactionId`: referência externa utilizada pelo provedor;
- `referenceTransactionId`: ID interno da transação original resolvida.

Para um `REFUND` ou `ROLLBACK`, o processador primeiro recebe a referência externa. Depois que a transação referenciada é encontrada e validada, seu ID interno é persistido.

A validação da referência verifica provedor, jogador, carteira, moeda, rodada, tipo e valor exato.

Se a transação original ainda não tiver chegado, a reversão pode entrar em `PENDING_REFERENCE`.

## Recuperação de referências pendentes

`PendingReferenceWorkerService` processa periodicamente reversões pendentes que estão prontas para nova tentativa.

O worker:

- tenta novamente referências ausentes utilizando backoff;
- pode ser executado concorrentemente por múltiplas instâncias;
- utiliza bloqueio de linhas no banco com `SKIP LOCKED`;
- resolve a reversão quando a transação referenciada aparece;
- rejeita a reversão com um código de falha estável após o limite configurado de tentativas.

## Estratégia de concorrência

A consistência financeira é garantida por transações PostgreSQL.

Alterações na carteira utilizam bloqueio pessimista no banco de dados, fazendo com que mudanças concorrentes de saldo na mesma carteira sejam serializadas.

O projeto também utiliza advisory transaction locks do PostgreSQL quando é necessária serialização para idempotência durável e processamento da inbox.

A contenção de locks pode ser observada por meio de:

```text
lock_conflicts_total
```

Um teste de integração dedicado cria intencionalmente um conflito real de advisory lock e comprova que o processamento continua com segurança após a liberação do lock.

## Idempotência

As requisições HTTP exigem:

```text
Idempotency-Key
```

A idempotência é persistida no PostgreSQL em vez de ser armazenada apenas em memória.

O processador armazena um hash canônico do payload junto ao registro de idempotência.

Comportamento:

- mesma chave + mesmo payload: replay seguro;
- mesma chave + payload diferente: conflito;
- múltiplas instâncias da aplicação: protegidas pelo banco de dados.

## Processamento SQS

A aplicação consome comandos de apostas de uma fila FIFO.

Filas locais padrão:

```text
wager-transactions.fifo
wager-transactions-dlq.fifo
wager-events.fifo
```

As filas são criadas automaticamente quando a aplicação inicia.

Formato da mensagem recebida:

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

O consumidor utiliza o mesmo caso de uso de apostas utilizado pelo HTTP.

Uma inbox persistente impede que a mesma mensagem da fila aplique seu efeito de negócio duas vezes, inclusive em cenários de falha antes do ACK.

As mensagens são removidas da fila de origem somente após o processamento ter sido confirmado no banco.

Mensagens inválidas pelas regras de negócio e mensagens que esgotam as tentativas são enviadas para a DLQ configurada.

## Outbox transacional

Eventos de domínio são gravados no PostgreSQL na mesma transação da alteração do estado financeiro.

Um publicador separado lê eventos ainda não publicados usando uma estratégia segura para múltiplos workers e os envia para `wager-events.fifo`.

Os eventos publicados incluem:

```text
WagerTransactionProcessed.v1
WagerTransactionRejected.v1
WagerTransactionPendingReference.v1
WalletBalanceChanged.v1
```

Isso impede que uma transação financeira já confirmada perca seu evento de integração correspondente caso o processo falhe após o commit no banco de dados.

## Observabilidade

Os logs são estruturados em JSON e evitam intencionalmente registrar payloads financeiros completos.

Identificadores relevantes podem incluir:

- `correlationId`
- `messageId`
- `transactionId`
- `walletId`
- `providerId`
- `failureCode`
- `retryCount`
- `durationMs`

Exemplos de métricas coletadas incluem:

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

Snapshot atual das métricas em processo:

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

O readiness verifica as dependências necessárias para a aplicação, em vez de indicar estado saudável apenas porque o processo HTTP está em execução.

## API HTTP

### Criar carteira

```http
POST /wallets
Content-Type: application/json
```

Exemplo:

```json
{
  "playerId": "player-001",
  "initialBalance": {
    "amount": "100.00",
    "currency": "BRL"
  }
}
```

### Consultar carteira

```http
GET /wallets/:id
```

### Consultar carteira ledger

```http
GET /wallets/:id/ledger?limit=20&cursor=...
```

A paginação do ledger utiliza um cursor baseado em `createdAt + id`, em vez de paginação com `OFFSET`.

### Processar aposta

```http
POST /wagering/transactions
Idempotency-Key: provider-a:bet-001
Content-Type: application/json
```

Exemplo de BET:

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

Exemplo de REFUND:

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

Uma reversão cuja transação original ainda não chegou pode retornar como `PENDING_REFERENCE`.

### Consultar aposta pelo ID interno

```http
GET /wagering/transactions/:id
```

### Consultar aposta pela referência do provedor

```http
GET /wagering/transactions/provider/:providerId/:externalTransactionId
```

### Reconciliar carteira

Endpoint canônico:

```http
POST /wallets/:walletId/reconciliation
```

Um alias de compatibilidade também está disponível:

```http
GET /reconciliation/wallets/:walletId
```

A reconciliação reconstrói de forma independente o saldo da carteira a partir das entradas do ledger e informa se o saldo armazenado está consistente.

As decisões arquiteturais, trade-offs e limitações conhecidas estão documentadas em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Configuração local

### Requisitos

Instale:

- Bun 1.x
- Docker
- Docker Compose

### 1. Instalar dependências

```bash
bun install
```

### 2. Iniciar PostgreSQL e MiniStack

```bash
docker compose up -d
```

Serviços locais padrão:

```text
PostgreSQL: 127.0.0.1:55432
MiniStack:  http://localhost:4566
```

### 3. Configurar o ambiente

Um `.env` local mínimo pode ser:

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

### 4. Executar migrations

```bash
bun run migration:up
```

### 5. Iniciar a aplicação

Desenvolvimento:

```bash
bun run start:dev
```

Inicialização normal:

```bash
bun run start
```

Build de produção:

```bash
bun run build
bun run start:prod
```

## Migrations do banco de dados

As migrations são versionadas em:

```text
src/migrations/
```

Aplicar:

```bash
bun run migration:up
```

Reverter a migration mais recente:

```bash
bun run migration:down
```

Criar uma nova migration:

```bash
bun run migration:create
```

## Testes

Executar todos os testes:

```bash
bun test
```

Executar o build antes da entrega:

```bash
bun run build
```

A suíte de testes cobre regras de domínio e cenários de integração com PostgreSQL/SQS, incluindo:

- comportamento exato de `Money`;
- invariantes de `Wallet`;
- transições de estado das apostas;
- validação de moeda;
- idempotência durável;
- conflitos de payload de idempotência;
- processamento HTTP;
- endpoints de carteira e ledger;
- reconciliação;
- recuperação da inbox após falhas;
- publicação da outbox;
- comportamento de retry e DLQ do SQS;
- encerramento gracioso do consumidor;
- recuperação de referências pendentes;
- observabilidade de referências pendentes;
- concorrência distribuída de carteiras;
- observabilidade de conflitos de lock;
- invariante financeiro final entre carteira e ledger.

### Cenário de concorrência

Um teste de integração começa com:

```text
balance = 100.00
```

e envia duas transações `BET` concorrentes de:

```text
80.00 + 80.00
```

Resultado esperado:

```text
uma transação processada
uma transação rejeitada por saldo insuficiente
saldo final = 20.00
um débito aplicado
```

Isso demonstra que a implementação não depende de um mutex limitado a um único processo.

### Invariante financeiro final

Outro teste de integração executa um ciclo de vida completo:

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

Ele verifica que:

- o saldo final da carteira é `100.00`;
- a versão da carteira muda apenas em operações que alteram o saldo;
- `LOSS` não cria entrada no ledger;
- referências de reversão são resolvidas para IDs internos das transações;
- cada `balanceBefore` do ledger corresponde ao `balanceAfter` anterior;
- o último `balanceAfter` do ledger é igual ao saldo persistido da carteira;
- o ledger consegue reconstruir de forma independente o saldo da carteira.

## Encerramento gracioso

Os hooks de encerramento do Nest estão habilitados.

Ao receber `SIGTERM` ou `SIGINT`:

- o consumidor SQS para de receber novos trabalhos;
- os loops em segundo plano param de iniciar novos ciclos;
- trabalhos em andamento são aguardados;
- os clientes SQS são destruídos somente após o encerramento dos workers.

## Segurança em múltiplas instâncias

O design evita depender de estado local do processo para garantir consistência.

A coordenação entre instâncias é fornecida pelo PostgreSQL por meio de:

- transações de banco de dados;
- locks pessimistas nas linhas das carteiras;
- advisory transaction locks;
- constraints únicas;
- registros persistentes de idempotência;
- registros persistentes de inbox;
- seleção de trabalho dos workers com `FOR UPDATE SKIP LOCKED`;
- estado persistente da outbox transacional.

Isso mantém as regras financeiras seguras quando várias instâncias da aplicação recebem trabalho concorrentemente.

## Verificação a partir de ambiente limpo

Para validar o projeto a partir de um ambiente local limpo:

```bash
docker compose down -v
docker compose up -d
bun install
bun run migration:up
bun run build
bun test
bun run start
```

Após a inicialização, verifique:

```text
GET http://localhost:3000/health/live
GET http://localhost:3000/health/ready
GET http://localhost:3000/metrics
```

## Trade-offs de design

### PostgreSQL como autoridade de coordenação

A consistência é coordenada pelo PostgreSQL, e não por um mutex em memória. Um lock em memória protegeria apenas um processo da aplicação e deixaria de ser suficiente assim que múltiplas instâncias fossem implantadas.

### Lock pessimista da carteira

Alterações da carteira são serializadas na própria linha da carteira. Essa escolha prioriza consistência financeira e invariantes simples em vez de paralelismo máximo para comandos direcionados à mesma carteira, enquanto carteiras diferentes ainda podem ser processadas concorrentemente.

### Idempotência e inbox persistentes

Tanto a idempotência HTTP quanto a deduplicação da fila sobrevivem a reinicializações do processo. Um cache somente em memória não protegeria contra novas tentativas após uma falha.

### Outbox transacional

A publicação externa é intencionalmente desacoplada da transação financeira do banco. O banco confirma atomicamente a alteração de negócio e a intenção do evento; a entrega assíncrona é tentada novamente de forma independente.

### Métricas em processo

Para o desafio, as métricas são expostas como um snapshot em processo em `/metrics`. Em um ambiente de produção, esse serviço poderia ser adaptado para Prometheus/OpenTelemetry sem alterar o modelo de negócio.

### Tratamento manual de falhas da fila

O consumidor diferencia explicitamente falhas que podem ser tentadas novamente, mensagens permanentemente inválidas e esgotamento de tentativas. Mensagens com falha podem ser encaminhadas para a DLQ configurada preservando o mesmo caso de uso de processamento.

## Checklist de entrega

Antes de enviar:

```bash
bun run build
bun test
```

Execução limpa recomendada:

```bash
docker compose down -v
docker compose up -d
bun run migration:up
bun run build
bun test
```

O repositório não deve depender de estado de banco de dados criado anteriormente nem de filas SQS criadas manualmente.
