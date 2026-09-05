# ARCHITECTURE.md

Este documento registra as decisões técnicas, os trade-offs e as limitações conhecidas
do Jungle Wagering Processor. O `README.md` cobre setup e comandos; este arquivo cobre
o "porquê" por trás das escolhas.

---

## 1. Autenticação (seção 2 do desafio)

**Decisão: não implementar autenticação neste desafio.**

Justificativa: a seção 2 do desafio deixa explícito que autenticação não vale pontos
na avaliação e não deve competir com correção financeira, concorrência e idempotência.
Optamos por concentrar o tempo disponível nos itens que de fato são avaliados (seção 14).

Se este projeto fosse para produção, a integração seria com um Identity Provider externo
via OIDC (Keycloak ou Zitadel, ambos citados no desafio como opções que sobem bem em
Docker Compose) — nunca com uma tabela própria de usuários e hash de senha.

**Ponto de extensão deixado explícito no código:** `src/infrastructure/auth/no-op-auth.guard.ts`
contém um `NoOpAuthGuard` (`CanActivate`) registrado globalmente via `APP_GUARD` em
`app.module.ts`. Hoje ele permite todas as requisições; para integrar um IdP real bastaria
substituir sua implementação por uma que valide o token OIDC/JWT do provider (sem alterar a
assinatura `CanActivate`). Ao trocar o no-op por autenticação real, o guard deve ignorar
explicitamente `/health/live` e `/health/ready` (ou usar um decorator público equivalente),
mantendo os health checks sem autenticação conforme exigido.

Escopo que este guard não cobre: mensagens vindas da fila SQS são tratadas como canal
interno confiável (conforme a seção 2), mas a identidade do provider contida no payload
continua sujeita às mesmas validações de domínio que a entrada HTTP.

---

## 2. Money e representação de dinheiro

`Money` (`src/domain/money/money.ts`) encapsula um `Decimal` (biblioteca `decimal.js`) e
uma moeda ISO-4217. Decisões:

- entrada e serialização sempre como string decimal com escala fixa de 2 casas
  (`^-?\d+\.\d{2}$`), rejeitando `NaN`, `Infinity`, notação científica e mais de 2 casas
  decimais pela própria regex;
- operações (`add`, `subtract`, `negate`) retornam sempre uma nova instância — imutável;
- `add`/`subtract`/`isLessThan` verificam a moeda antes de operar, lançando erro de domínio
  em caso de mismatch;
- o domínio não depende de tipos monetários do MikroORM: a conversão para `decimal(18,2)`
  acontece só na camada de persistência (`runtimeType: 'string'` nas entities), então o
  valor trafega como string do banco até o domínio sem passar por `number` em nenhum ponto.

O desafio permite reduzir o escopo assumindo uma única moeda (BRL); seguimos essa redução,
mas o modelo (`Money`, `Wallet`, `WagerTransaction`) continua agnóstico de moeda e o
conflito de moedas é testado (`money.spec.ts`, `wallet.spec.ts`).

---

## 3. ORM: MikroORM

Optamos pelo MikroORM (preferencial no desafio) pelo `EntityManager.transactional()`
explícito e pelo suporte de primeira classe a `LockMode.PESSIMISTIC_WRITE` e a queries SQL
cruas (`em.execute`) — usadas tanto para os locks consultivos (`pg_advisory_xact_lock`)
quanto para o `SELECT ... FOR UPDATE SKIP LOCKED` dos workers em background. TypeORM cobriria
o CRUD básico, mas expressar essas duas primitivas de concorrência com controle fino do SQL
ficaria menos direto.

---

## 4. Estratégia de concorrência (seção 8 do desafio)

A unidade de concorrência é a `walletId`, como pede o desafio. A estratégia combina duas
técnicas, cada uma resolvendo um problema diferente:

1. **Lock pessimista de linha (`PESSIMISTIC_WRITE`) na wallet.** Toda operação que
   movimenta saldo carrega esse lock ao buscar a `WalletEntity` dentro da transação.
   Isso serializa fisicamente qualquer operação concorrente sobre a mesma wallet — a
   segunda transação bloqueia no `SELECT ... FOR UPDATE` até a primeira commitar, e então lê
   o saldo já atualizado. Isso é o que garante o cenário obrigatório da seção 8 (duas apostas
   de 80.00 contra saldo de 100.00 → exatamente uma processada, saldo final 20.00, um único
   lançamento de débito), coberto em `test/integration/distributed-concurrency.integration.spec.ts`
   com três conexões MikroORM independentes simulando três instâncias reais da aplicação.

2. **Locks consultivos transacionais (`pg_advisory_xact_lock`) por `idempotencyKey` e por
   `(consumerName, messageId)` do inbox.** O lock pessimista da wallet só existe depois que a
   wallet é localizada; antes disso, duas requisições idênticas em paralelo (mesmo
   `Idempotency-Key`, ou mesma mensagem SQS reentregue por duas instâncias ao mesmo tempo)
   ainda poderiam colidir na criação do registro de idempotência ou do inbox. O advisory
   lock serializa esse trecho inicial sem depender de um mutex em memória (que só protegeria
   um processo). Conflitos de lock são contados em `lock_conflicts_total` e testados em
   `test/integration/lock-observability.integration.spec.ts`, que provoca um conflito real e
   comprova que o processamento é retomado com segurança após o lock ser liberado.

Trade-off assumido: serialização por wallet reduz o paralelismo máximo de operações que
disputam a mesma wallet, em troca de invariantes financeiras simples de raciocinar. Wallets
diferentes continuam sendo processadas em paralelo sem qualquer lock compartilhado entre
elas — não existe lock global.

Os `FOR UPDATE SKIP LOCKED` usados pelo `PendingReferenceWorkerService` e pelo
`OutboxPublisherService` resolvem um problema diferente (coordenação entre múltiplos workers
concorrentes disputando o *mesmo* lote de trabalho, não a mesma wallet) e por isso usam
"pular se já estiver travado" em vez de bloquear.

---

## 5. Idempotência (seção 9 do desafio)

- `IdempotencyRecordEntity` é a fonte da verdade; a chave (`idempotencyKey`, tipicamente
  `"{providerId}:{externalTransactionId}"`) tem constraint `UNIQUE` no banco.
- `payloadHash` é um SHA-256 de um JSON canônico (chaves ordenadas recursivamente,
  `src/domain/idempotency/payload-hash.ts`) do subconjunto de campos de negócio. Ficam de
  fora do hash: `idempotencyKey`, o `transactionId` interno e qualquer metadado de
  transporte — para que replay real (mesma requisição) e conflito (mesma chave, payload
  diferente) sejam distinguíveis.
- Uma requisição repetida com o mesmo payload retorna a resposta original armazenada em
  `responseBody`, com `idempotentReplay: true`. Payload diferente lança
  `IDEMPOTENCY_KEY_CONFLICT`, mapeado para HTTP 409.
- Como a criação do registro de idempotência acontece na mesma transação SQL que a
  movimentação financeira e o outbox, não existe janela onde a operação foi aplicada mas a
  idempotência ainda não foi persistida (ou vice-versa).

---

## 6. Inbox e mensageria (seção 10 do desafio)

`WagerSqsConsumerService` reaproveita o mesmo `ProcessWagerService.execute()` usado pelo
HTTP, passando o contexto de inbox. Dentro da transação:

- o inbox é verificado por `(consumerName, messageId)`, com `UNIQUE` no banco;
- se a mensagem já foi processada (`processedAt` preenchido), a movimentação financeira é
  pulada e a entrega é apenas reconhecida (`ack`) — cobre o cenário de crash entre o commit e
  o `ack` original: uma redelivery do SQS encontra o inbox já concluído e não duplica efeito;
- o `ack` (`DeleteMessageCommand`) só acontece depois que `execute()` retorna com sucesso.

O consumidor distingue três classes de erro:

- **erro de formato/parsing** (`INVALID_SQS_*`) → permanente, vai direto para a DLQ;
- **erro de negócio** (ex.: saldo insuficiente) → não é uma exceção lançada pelo caso de
  uso; a transação é marcada `REJECTED` dentro do mesmo commit e a mensagem é reconhecida
  normalmente — reprocessar não mudaria o resultado;
- **erro transitório** (ex.: falha de conexão) → não faz `ack`; a mensagem volta a ficar
  visível após o `VisibilityTimeout` e é reentregue. Após `SQS_WAGER_MAX_ATTEMPTS` tentativas
  sem sucesso, vai para a DLQ.

**Conflitos permanentes de payload:** `INBOX_MESSAGE_CONFLICT` e
`IDEMPOTENCY_KEY_CONFLICT` são classificados como permanentes pelo consumer. Como o mesmo
identificador/chave já está persistido com outro payload, retry não pode tornar a mensagem
válida; ela segue diretamente para a DLQ em vez de consumir tentativas transitórias.

---

## 7. Transactional Outbox (seção 11 do desafio)

Os eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`,
`WagerTransactionPendingReference`, `WalletBalanceChanged`) são persistidos em
`outbox_events` na mesma transação que gera o efeito financeiro — nunca publicados antes do
commit. `OutboxPublisherService` roda como um worker separado que:

- seleciona lotes pendentes com `SELECT ... FOR UPDATE SKIP LOCKED`, permitindo múltiplos
  publishers concorrentes sem duplicar nem perder trabalho entre eles;
- marca `publishedAt` só após a confirmação do transporte SQS;
- em caso de falha de publicação, agenda retry com backoff (`scheduleRetry`) em vez de
  perder o evento.

Isso cobre o cenário do desafio: commit no Postgres → processo morre antes de publicar →
outra instância assume o outbox pendente → evento é publicado. Uma publicação duplicada
(ex.: o processo publica mas morre antes de marcar `publishedAt`) é seguro para o
consumidor porque os eventos carregam `eventId` estável e o modelo assume consumidores
idempotentes do lado de fora — isso é uma responsabilidade do lado consumidor do evento, não
deste serviço.

---

## 8. Referências fora de ordem (seção 7.1)

Quando um `REFUND`/`ROLLBACK` chega antes da transação que referencia, ele é persistido como
`PENDING_REFERENCE` (não como erro) e o `PendingReferenceWorkerService` o retenta
periodicamente. Decisões:

- seleção de linhas devidas via `FOR UPDATE SKIP LOCKED` sobre `wager_transactions`, para que
  múltiplas instâncias do worker dividam o trabalho sem duplicar tentativas;
- número de tentativas e o próximo horário de retry (`referenceRetryCount`,
  `nextReferenceRetryAt`) são persistidos na própria linha — um restart do processo não perde
  o progresso do backoff;
- limite padrão de `PENDING_REFERENCE_MAX_ATTEMPTS = 5` com backoff base de
  `PENDING_REFERENCE_BASE_BACKOFF_SECONDS = 5`; esgotado o limite, a transação é rejeitada com
  `REFERENCE_NOT_FOUND_AFTER_RETRIES` e o evento de rejeição correspondente é publicado pela
  outbox. Esses valores são configuráveis por variável de ambiente e foram escolhidos para o
  ambiente de desenvolvimento/teste local — não são uma recomendação de produção.

---

## 9. Ledger e reversões

- Cada transação financeira gera **no máximo um** lançamento por wallet (`UNIQUE
  (transactionId, walletId)` em `wallet_ledger_entries`).
- `LOSS` e qualquer transação `REJECTED` não geram lançamento — não afetam saldo.
- A aritmética de cada lançamento (`balance_after = balance_before ± amount`, conforme a
  direção) é validada por `CHECK` constraint no próprio Postgres, não só em código de
  aplicação (seção 5, restrição 9 do desafio).
- `REFUND` só reverte `BET`; `ROLLBACK` reverte `BET`, `WIN` ou `REFUND`. Uma referência não
  pode ser revertida duas vezes pelo mesmo tipo de operação — verificado consultando se já
  existe um `REFUND`/`ROLLBACK` `PROCESSED` apontando para aquela `referenceTransactionId`
  antes de aplicar a reversão, dentro da mesma transação que segura o lock da wallet.
- Reversão que resultaria em saldo negativo é rejeitada com `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE`,
  um código distinto de `INSUFFICIENT_FUNDS` (usado só para `BET`), porque são situações
  operacionalmente diferentes: uma é uma aposta nova sem saldo, a outra é uma reversão que
  não pode ser aplicada sem violar a invariante de não-negatividade.
- Ledger de partidas dobradas (double-entry) não foi implementado — é diferencial opcional
  no desafio, e o tempo foi priorizado para os itens obrigatórios.

Double-entry bookkeeping ficou fora do escopo (é diferencial opcional na seção 6.4).

---

## 10. Observabilidade

Métricas ficam em memória e são expostas via `GET /metrics` como um snapshot. Em produção
esse serviço seria trocado por um exportador Prometheus/OpenTelemetry sem alterar o modelo de
negócio — os pontos de instrumentação (`incrementCounter`, `observeLatency`) já estão
isolados atrás de `ObservabilityService`. Logs são estruturados em JSON e carregam
identificadores de correlação (`correlationId`, `messageId`, `transactionId`, `walletId`,
`providerId`, `failureCode`, `retryCount`, `durationMs`) sem payloads financeiros completos.

---

## 11. Limitações conhecidas

- Sem autenticação real (ver seção 1 acima).
- Métricas em memória por instância (não agregadas entre instâncias); adequado para o
  desafio, insuficiente para operação real com múltiplas réplicas atrás de um load balancer.
- Reversão parcial (`REFUND`/`ROLLBACK` de valor diferente do original) está fora de escopo,
  conforme o próprio desafio define.
- Ledger de partidas dobradas não implementado (diferencial opcional).
- Teste de carga (`bun run test:load`) não implementado — diferencial opcional do desafio.
