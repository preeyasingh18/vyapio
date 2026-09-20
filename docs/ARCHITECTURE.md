# Architecture

Written for an engineer picking this up cold. It covers what the pieces are,
and — more usefully — why each one is the way it is.

---

## The system

```
                              VYAPIO
                                 │
                   ┌─────────────┴─────────────┐
                   │                           │
            SHOPKEEPER PWA              CUSTOMER PWA
                   │                           │
                   └─────────────┬─────────────┘
                                 │
                      React + Vite + Tailwind
                    (offline-first, 7 languages)
                                 │
                          Amazon Cognito
                       (JWT verified server-side)
                                 │
                     API Gateway (HTTP API)
                                 │
                                 ▼
              ┌──────────────────────────────────┐
              │        ONE LAMBDA                │
              │        Docker image on ECR       │
              │                                  │
              │  /auth        /voice             │
              │  /customers   /documents         │
              │  /transactions /search           │
              │  /khata       /ai                │
              │  /inventory   /agent             │
              │  /orders      /sync              │
              │  /payments    /me                │
              └──────────────┬───────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
    DynamoDB                S3                Bedrock
   single table        tenant-keyed              │
        │                    │        ┌──────────┼──────────┐
        │                    ▼        ▼          ▼          ▼
        │               Textract   parsing  Knowledge   AgentCore
        │              (printed)             Base          │
        │                                       │          │
        │                                  Transcribe      │
        │                                 (streaming)      │
        │                                                  │
        └──────────────────► EventBridge ◄─────────────────┘
                                 │
                                 ▼
                                SNS
```

---

## The decisions

### One Lambda, not ten

A Docker image on ECR, invoked by API Gateway, containing the entire API.

Splitting this into a function per resource would buy independent scaling that
a neighbourhood shop will never need, and cost ten cold starts, ten IAM roles,
ten sets of environment variables to keep in step, and ten places for
configuration to drift. The code inside is already modular — `routes/`,
`services/`, `middleware/` — which is where modularity actually pays.

The same function also receives the EventBridge rules, so the asynchronous work
runs on warm containers the request path already paid to start.

**Where to look:** `backend/src/handler.ts` (Lambda entry, HTTP and event),
`backend/src/app.ts` (routing and middleware), `backend/Dockerfile`.

### The local server is the same code

`backend/src/local-server.ts` is a Node HTTP adapter over the exact
`handleRequest` the Lambda calls. Both reduce their transport to a
`RequestContext` and hand it to one pipeline:

```
request id → logger → CORS → auth → rate limit → route → handler → errors
```

There is no second implementation, so a bug cannot hide in the gap between
development and production.

### Every AWS service has a local counterpart

Ports and adapters, chosen by whether the relevant environment variables are
present:

| Subsystem | AWS | Local |
| --- | --- | --- |
| Database | DynamoDB | `LocalStore` — a JSON file with the same key semantics |
| Auth | Cognito | HMAC-signed session tokens, refused when `STAGE=prod` |
| AI parsing | Bedrock | `localParser` — a Hinglish rule engine |
| Retrieval | Knowledge Bases | Deterministic scoring over the shop's own rows |
| Agent | AgentCore | In-process planner, same tools and permissions |
| Voice | Transcribe Streaming | The browser's Web Speech API |
| Documents | Textract | Unavailable, and it says so |
| Events | EventBridge | In-process dispatch to the same handlers |
| Notifications | SNS / WhatsApp | `MockProvider` — records, reports `not_delivered` |

This is not a demo shortcut. It means the whole product — including the
tenant-isolation tests — runs with no AWS account, and it degrades one
subsystem at a time rather than wholesale.

`describeRuntime()` reports which mode each subsystem is in, the client renders
it as a **Local mode** badge, and Settings lists it per subsystem. **A local
write is never presented as though it reached AWS.**

**Where to look:** `backend/src/config/index.ts`, `backend/src/services/`.

### One table, tenancy in the key schema

```
ENTITY            pk                  sk
────────────────────────────────────────────────────────────
Vendor            VENDOR#<id>         PROFILE
Customer          VENDOR#<id>         CUSTOMER#<customerId>
Product           VENDOR#<id>         PRODUCT#<productId>
Transaction       VENDOR#<id>         TXN#<timestamp>#<txnId>
Payment           VENDOR#<id>         PAY#<timestamp>#<payId>
Commitment        VENDOR#<id>         CMT#<dueDate>#<cmtId>
Order             VENDOR#<id>         ORD#<createdAt>#<orderId>
InventoryEvent    VENDOR#<id>         IVE#<timestamp>#<eventId>
AIAction          VENDOR#<id>         ACT#<createdAt>#<actionId>
Notification      VENDOR#<id>         NTF#<createdAt>#<notifId>
Idempotency       VENDOR#<id>         IDEM#<key>

GSI1 (gsi1pk/gsi1sk) — lookups across partitions
  USER#<userId>             → login resolves to a vendor
  QR#<qrId>                 → a scan resolves to a customer
  PHONE#<vendorId>#<phone>  → the scanner's phone fallback
  CUSTLINK#<userId>         → the customer app's linked shops

GSI2 (gsi2pk/gsi2sk) — the customer timeline, across entity types
  CUST#<customerId>         → TXN#/PAY#/CMT#/ORD# in time order
```

Every shop-owned item shares `pk = VENDOR#<vendorId>`. A Query for one vendor
*physically cannot* return another's rows — isolation is a property of the key
schema, not of remembering to add a filter.

Sort keys embed an ISO timestamp, which sorts lexicographically, so "the last 20
sales" is one backwards Query with no filter and no sort.

GSI1 and GSI2 are global, so a lookup through them is re-scoped to the caller's
vendorId on the way out. `backend/tests/tenancy.test.ts` has a test for exactly
that leak.

**Where to look:** `backend/src/services/dynamodb.ts`,
`backend/src/services/repository.ts`.

### Money is integer paise

Every monetary value in the system is an integer count of paise. Floating-point
rupees lose money across enough transactions, and a shop's khata is precisely
where that must not happen. `PaiseSchema` rejects non-integers, so a float
cannot enter the domain at all. Conversion to a fractional rupee happens once,
at the display edge.

**Where to look:** `backend/src/utils/money.ts`, `frontend/src/lib/format.ts`.

### A sale is one transactional write

Recording a sale touches six things:

```
transaction
  · an InventoryEvent per line
  · a stock decrement per product
  · the customer's balance and counters
  · a Payment if money changed hands
  · a Commitment if it did not
```

All of it goes through a single `transactWrite`, because every state in between
is wrong — stock reduced with no sale recorded, or a balance owed with nothing
explaining it. Stock and balances use DynamoDB's atomic `ADD` rather than
read-modify-write, so two tills selling the last two bags of rice are both
reflected.

**Where to look:** `backend/src/services/ledger.ts`.

---

## The AI contract

The rule that shapes every AI feature:

```
speech → transcript → extraction → schema validation → draft
   → HUMAN CONFIRMATION → domain logic → database → event → insight
```

There is no code path from a model to a write that skips the confirmation step.
Not a policy — an absence.

### Voice

`POST /voice/parse` returns a **draft**. It never writes. Confirming posts that
(possibly edited) draft to `POST /transactions` like any other sale.

Between extraction and the draft, code does the work that makes it trustworthy:

- the spoken name is resolved against real customers — two Rameshes produce a
  picker, never a guess
- products are matched to the real catalogue by name and alias
- **prices come from the catalogue, never from the model**
- the arithmetic is recomputed in integer paise

When Bedrock is enabled, the deterministic parser runs *too*, and their money
fields are compared. A disagreement does not pick a winner — it raises an
ambiguity and drops the confidence, which is what produces *"We heard ₹480. Did
you mean ₹580?"* rather than a silent wrong number.

**Where to look:** `backend/src/routes/voice.ts`,
`backend/src/services/localParser.ts`, `backend/src/services/bedrock.ts`.

### Shop Memory

**Retrieval decides what is true; the model only decides how to say it.**

Records are selected by code. They become the citations rendered under the
answer. The model is handed exactly those records and forbidden to add to them.
If retrieval finds nothing, there is no model call at all — the user sees
*"I couldn't find enough information in your shop records."*

That ordering is why *"What did Ramesh buy last month?"* cannot invent a
purchase: it either appears in the citation list or the answer says it was not
found.

**Where to look:** `backend/src/services/knowledgeBase.ts`.

### Shop Pulse

Every number is computed in code. The model supplies only `narration`, and every
card renders correctly with it empty — which is exactly what happens when
Bedrock is off.

`daysRemaining = stock / salesVelocity` is a division, and a division should be
a division.

**Where to look:** `backend/src/routes/ai.ts`,
`backend/src/services/inventory.ts`.

### The agent

Three properties, each enforced structurally rather than by prompt:

1. **It can only call tools it was granted.** `runTool` checks an allow-list
   before dispatching. There is no "run a query" tool and no repository
   passthrough.
2. **It cannot cause a side effect.** Every tool is read-only or
   *prepare-write*. `createReminder` drafts messages and returns them;
   delivery happens only in `POST /agent/confirm`, which requires a matching
   `actionId` from the same authenticated vendor.
3. **It cannot claim a delivery that did not happen.** `DeliveryResult` has
   separate `ok` and `delivered` fields. The mock provider returns
   `delivered: false`, and the confirmation screen reports per recipient.

Every run is written to `AIAction` *before* execution and updated after, so a
crash mid-flight still leaves a trace of what was about to happen.

**Where to look:** `backend/src/services/agentTools.ts`,
`backend/src/services/agentCore.ts`, `backend/src/routes/agent.ts`.

---

## Offline

A neighbourhood shop's connection drops constantly, and a shopkeeper mid-sale
cannot wait for it.

Safe actions are queued locally with an idempotency key generated **once** and
reused across every replay — regenerating it per attempt would defeat the whole
mechanism. On reconnect the batch posts to `/sync`, which replays each action
independently and returns a per-action outcome. A duplicate counts as success:
the record is safely stored, so it must leave the queue.

The rule every piece of copy obeys: **a queued action has not been saved.** It
is "waiting to sync" until the server confirms it.

**Where to look:** `frontend/src/lib/offlineQueue.ts`,
`backend/src/routes/sync.ts`.

---

## Events

Recording a sale is one fact; the consequences are separate concerns that should
not make the shopkeeper wait. Events are published *after* the write commits, so
a handler can never observe a sale that is not durably stored.

```
CustomerCreated · TransactionCreated · PaymentRecorded
InventoryChanged · CommitmentCreated · OrderReady · AgentActionExecuted
```

Handlers are written to **converge** rather than increment — sales velocity is
recomputed from the event log, not adjusted — which is what makes EventBridge's
at-least-once delivery harmless.

Notably, `OrderReady` only logs. Wiring it to a notification would turn "mark
order ready" into "message the customer", which is the kind of silent side
effect this product does not do.

**Where to look:** `backend/src/services/events.ts`, `backend/src/handlers.ts`.

---

## Frontend

React 19 + Vite 8 + Tailwind v4, feature-first.

- **`@shared` alias** → `backend/src/schemas`. One definition of every entity.
  That directory is kept dependency-free (zod only) precisely so the browser can
  import it.
- **Lazy routes.** The QR decoder is ~478 kB and loads only on the scanner
  screen.
- **Two navigations, not one responsive compromise.** Mobile gets five tabs with
  a raised SCAN button under the thumb; desktop gets a full sidebar.
- **Motion degrades to nothing.** Every animated component checks
  `useReducedMotion`, which is safe because no animation carries information
  that is not also in text.
- **Severity has three channels** — icon shape, colour, and a screen-reader
  label — so urgency survives colour-blindness.

---

## Observability

Structured JSON, one object per line, for CloudWatch Logs Insights:

```
requestId · userId · vendorId · operation · durationMs · status · errorCode
```

Redaction is structural rather than by convention: keys matching `password`,
`token`, `secret`, `authorization`, `code` and similar are replaced before
serialisation. An allow-list keeps `errorCode` and `statusCode` — the fields
queries actually filter on — from being swallowed by the `code` pattern.

**Where to look:** `backend/src/utils/logger.ts`.

---

## Errors

Two audiences, two messages. `message` is technical and goes to CloudWatch;
`userMessage` is the calm sentence the shopkeeper sees. `toAppError` funnels
anything unrecognised into a generic 500 and keeps the detail server-side, so a
raw `ThrottlingException` never reaches a user.

```
Bedrock down    → "AI is temporarily unavailable. Your transaction is still safe."
Transcribe      → "We couldn't hear that clearly. Try again."
Offline         → "You're offline. This action will sync when you're back."
DynamoDB        → "We couldn't save this right now. Please try again."
```

**Where to look:** `backend/src/utils/errors.ts`.

---

## Stacks

Split by lifecycle rather than by service — the database and user pool outlive
everything and are what you least want replaced, while the Lambda and API are
redeployed constantly.

| Stack | Contents |
| --- | --- |
| `Database` | DynamoDB table, GSI1, GSI2 |
| `Cognito` | User pool, app client, hosted domain |
| `Storage` | S3 for voice, documents, receipts |
| `Events` | EventBridge bus, SNS topic |
| `Ai` | IAM role for a Knowledge Base (see below) |
| `Lambda` | ECR repo, Docker Lambda, IAM, the EventBridge rule and its DLQ |
| `Api` | HTTP API, CORS, throttling |
| `Frontend` | S3 + CloudFront with OAC |

Two ordering details that took a while to get right and are easy to reintroduce:

- The EventBridge **rule lives in the Lambda stack**, not the Events stack.
  Lambda already depends on Events for the bus name; a rule over there targeting
  the function would close the loop into a dependency cycle.
- The rule's **DLQ lives there too**, for the same reason — EventBridge grants
  the rule's ARN on the queue.

`AiStack` deliberately creates only IAM. A Knowledge Base needs a vector store,
and every managed option carries a standing hourly cost (OpenSearch Serverless
is roughly $300/month at minimum capacity). Provisioning that from a template
would hand somebody an unpleasant bill for a feature they may never enable.
`docs/AWS_SETUP.md` walks through creating it.
