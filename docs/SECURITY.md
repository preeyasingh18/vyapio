# Security

How Vyapio protects a shop's data, and what it deliberately does not claim.

---

## The threat that matters most

A shop's ledger is money and relationships. The realistic failures are not
exotic:

1. **One shop reads another's customers.** Commercially damaging, and the
   easiest mistake to make in a multi-tenant system.
2. **A customer reads a stranger's balance.** Private financial information.
3. **The AI moves money or messages people without being asked.** The fastest
   way to lose a shopkeeper's trust permanently.
4. **The app says something was saved or sent when it was not.** Quieter than
   the others, and worse — the shopkeeper stops chasing the money.

Everything below is organised around those four.

---

## 1. Tenant isolation

### vendorId comes from the session, never from the client

The single most important property in the system.

```ts
// backend/src/middleware/auth.ts
export async function requireVendor(ctx) {
  const auth = requireRole(ctx, 'SHOPKEEPER');      // verified JWT
  const vendor = await vendors.findByUserId(auth.userId);  // store lookup
  if (!vendor) throw forbidden('No shop is linked to this account');
  return { auth, vendor, vendorId: vendor.vendorId };
}
```

`vendorId` is resolved from the store using the verified token's subject. It is
**never** read from a body, query string, path parameter or header. Look through
`backend/src/schemas/requests.ts` — no request schema accepts a `vendorId`. A
handler that wanted to serve another shop's data would have to go out of its way
to construct one, rather than merely forgetting a check.

### Isolation is in the key schema

Every shop-owned item has `pk = VENDOR#<vendorId>`. A DynamoDB Query for one
vendor physically cannot return another's rows. This is structural, not a filter
somebody might omit.

### Global indexes are re-scoped on the way out

GSI1 and GSI2 are global by definition, so anything resolved through them is
checked against the caller's vendorId before it is returned:

```ts
const customer = toEntities<Customer>(result.items)
  .find((candidate) => candidate.vendorId === vendorId);
```

`backend/tests/tenancy.test.ts` has a test for exactly this leak — a customerId
from another shop passed to `GET /transactions?customerId=…`, which reaches a
GSI that is not partitioned by vendor.

### 404, not 403

Another shop's customer returns *not found*. Confirming that an id exists
elsewhere would itself leak information.

### S3 keys are built, not accepted

```
vendors/{vendorId}/voice/
vendors/{vendorId}/documents/
```

Keys are constructed server-side from the session's vendorId; callers pass what
they are storing, never where it goes. `assertKeyBelongsTo` is then applied on
every read and write of a key that arrived from a client, so a crafted key is
rejected even if a route forgets to check. Filenames are stripped of traversal
before use.

### Ten tests, one job

`backend/tests/tenancy.test.ts` attacks this from every angle a client
controls — path parameters, request bodies, query strings, QR tokens, phone
numbers, product edits and aggregate figures. Including the one that matters
most:

```ts
it('ignores a vendorId supplied in the request body', ...)
```

---

## 2. Customer access

A customer is a customer of several shops, so the question inverts: not "which
shop is this user?" but "which (shop, customer) pairs have they proved they
own?"

Proof is possession of the printed card's token. `requireCustomerLinks` resolves
the link rows; `assertCustomerAccess` gates every read of a specific profile.
Without it, a customer could page through `/me/shops/:vendorId/:customerId` and
read strangers' balances.

Customer sessions are granted **no agent tools at all**:

```ts
export const CUSTOMER_TOOLS: ReadonlySet<AgentToolName> = new Set();
```

### The QR code

It contains `vyapio://c/<token>` and nothing else. No name, no phone number, no
balance, no history.

- 24 base-36 characters ≈ **124 bits** of entropy — not enumerable
- resolved only within the authenticated vendor's tenant
- useless to anyone who photographs it without a Vyapio account

The customer's QR screen states this on screen, because somebody handing a card
across a counter deserves to know what is on it.

---

## 3. The AI cannot act alone

### The pipeline

```
speech → transcript → extraction → schema validation → draft
   → HUMAN CONFIRMATION → domain logic → database
```

There is no code path from a model to a write that skips confirmation. Not a
policy — an absence. `POST /voice/parse` returns a draft and writes nothing;
confirming posts it to `POST /transactions` like any other sale.

### Three structural guarantees for the agent

**It can only call tools it was granted.**

```ts
if (!context.allowed.has(name)) {
  logger.warn('agent tool denied', { vendorId, userId, tool: name });
  throw forbidden(`Agent is not permitted to use ${name}`);
}
```

There is no "run a query" tool, no repository passthrough, no way to name a
table. Every tool takes vendorId from the caller's session.

**It cannot cause a side effect.** Every tool is `read` or `prepare-write`.
`createReminder` drafts messages and returns them. Delivery happens only in
`POST /agent/confirm`, which requires a matching `actionId`, from the same
authenticated vendor, on an action still in `awaiting_confirmation`. A replay
gets a 409.

**Everything is audited.** `AIAction` rows are written *before* execution and
updated after, so a crash mid-flight still leaves a trace of what was about to
happen. Read-only runs are logged too — knowing what was asked matters as much
as knowing what was done.

### The model never supplies a number that matters

- Prices come from the catalogue, never from speech
- Arithmetic is recomputed in integer paise
- `daysRemaining = stock / salesVelocity` is a division in code
- Bedrock supplies only `narration`, and every card renders without it

When Bedrock is enabled, the deterministic parser runs too and their money
fields are compared. A disagreement raises an ambiguity rather than picking a
winner.

---

## 4. Honesty

Not a security control in the usual sense, but the property a shopkeeper's trust
actually rests on.

### Delivery is reported truthfully

```ts
export type DeliveryResult = {
  ok: boolean;        // processed without error
  delivered: boolean; // a message actually left this system
  detail: string;     // in plain language, shown to the shopkeeper
};
```

The mock provider returns `delivered: false` with *"Recorded only — no messaging
provider is configured, so nothing was sent to the customer."* The agent's
summary then reads **"Nothing was sent"**, not "3 reminders sent". Per-recipient
outcomes are listed individually.

`backend/tests/agent.test.ts` asserts on that exact string.

### Local is never dressed as cloud

`describeRuntime()` reports each subsystem's mode. The client renders a **Local
mode** badge on every screen and lists it per subsystem in Settings. A write to
the local file store is never presented as though it reached AWS.

### Queued is never "saved"

An offline action reads *"waiting to sync"* until the server confirms it. The
save button itself changes label when offline.

### AI-written rows are labelled

Voice and agent transactions carry their `source` and it is shown in the
timeline, so an AI-written entry is never indistinguishable from a typed one.

---

## Authentication

### Cognito

Sign-up, verification, password reset and refresh all happen in Cognito. The API
sees only JWTs and verifies them against the pool's JWKS with `aws-jwt-verify`.

`USER_PASSWORD_AUTH` is driven server-side deliberately: if the pool uses a
confidential client, the secret computes the `SECRET_HASH` on the server and
never reaches the browser.

### Local development auth

With no user pool configured, the API issues its own HMAC-signed tokens against
a PBKDF2 password record (120,000 iterations, SHA-512, per-user salt).

This is a development convenience and is **refused outright in production**:

```ts
export function assertProductionSafety(): void {
  if (!config.isProd) return;
  if (config.auth.mode === 'local') {
    problems.push('USER_POOL_ID/USER_POOL_CLIENT_ID are required when STAGE=prod');
  }
  // …also rejects a local database and localhost in CORS
  if (problems.length > 0) throw new Error(...);
}
```

It runs at cold start, so a misconfigured production deployment fails before it
serves a single request.

### No account enumeration

Wrong password and unknown account return **identical** responses. Password
reset returns the same message either way. Cognito's
`preventUserExistenceErrors` is on. There are tests for all three.

---

## Input validation

Every handler parses through a Zod schema before doing anything else, so it only
ever sees a fully-checked value. Failures return field-level messages a form can
render inline.

Two schema-level guarantees worth calling out, because they make malformed money
*unrepresentable*:

```ts
.refine((t) => t.subtotal === t.items.reduce((sum, i) => sum + i.lineTotal, 0))
.refine((t) => t.total === t.subtotal - t.discount)
.refine((t) => t.paid + t.outstanding === t.total)
```

A transaction where paid + outstanding ≠ total cannot be constructed, whatever a
model returns.

`PaiseSchema` rejects non-integers, so a float cannot enter the domain.

---

## Secrets

- `.env` is git-ignored; `.env.example` documents every variable and contains no
  values
- No AWS credentials anywhere in the repository — the SDK resolves them from the
  environment or the instance role
- `VITE_*` is compiled into the browser bundle and is **public**; only
  identifiers go there, never secrets
- `USER_POOL_CLIENT_SECRET` is read server-side only
- CDK writes configuration into the Lambda's environment at deploy time

### Logs

Redaction is structural, not by convention:

```ts
const REDACTED_KEYS = ['password', 'token', 'secret', 'authorization',
  'cookie', 'accesskey', 'credential', 'signature', 'otp', 'code', 'pin'];
```

Applied recursively before serialisation, so "remember not to log the token"
cannot fail. An allow-list keeps `errorCode` and `statusCode` — the fields
CloudWatch queries filter on — from being swallowed by the `code` pattern.

---

## Transport and headers

Every response carries:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cache-Control: no-store
```

CloudFront adds `Permissions-Policy: camera=(self), microphone=(self),
geolocation=()` — the scanner needs the camera and voice needs the microphone;
nothing else is allowed.

**CORS** is strict in production: only configured origins get headers, and an
unlisted origin gets none. Development reflects the caller so LAN testing on a
real phone works, and `assertProductionSafety` rejects localhost in a production
allow-list.

**Rate limiting** is per-identity, keyed by userId when known so one busy shop
cannot lock out another behind the same NAT. API Gateway throttling is
configured as well.

---

## IAM

Each grant in `infrastructure/lib/lambda-stack.ts` is the narrowest that works.
The Lambda can read and write its own table and bucket and has no DynamoDB or S3
permissions beyond them — not even the ability to create or delete either.

Cognito permissions are worth reading:

```ts
actions: [
  'cognito-idp:SignUp',
  'cognito-idp:ConfirmSignUp',
  'cognito-idp:ResendConfirmationCode',
  'cognito-idp:InitiateAuth',
  'cognito-idp:ForgotPassword',
  'cognito-idp:ConfirmForgotPassword',
  'cognito-idp:GlobalSignOut',
],
resources: [props.userPool.userPoolArn],
```

Every `Admin*` action is deliberately absent. The API cannot read or modify any
user other than through the authenticated flows above — which is also why the
seed script cannot create the demo user when Cognito is live.

Bedrock permissions are added only when Bedrock is enabled, and scoped to the
configured region's models and inference profiles.

---

## Data protection

| | |
| --- | --- |
| DynamoDB | AWS-managed encryption, point-in-time recovery |
| S3 | SSE-S3, TLS enforced, all public access blocked |
| CloudFront | Origin access control; the bucket stays closed to the internet |
| In transit | HTTPS throughout; HTTP redirects |
| Retention | Voice recordings expire after 90 days — the transcript is already on the transaction, so keeping the audio is cost and exposure with no matching benefit |
| Deletion | `dev` stacks are destroyable; `staging`/`prod` retain the table, pool and buckets by design |

---

## What is not claimed

Stated plainly, because an honest limitation is worth more than an unearned tick.

- **Not penetration tested.** No third party has attacked this.
- **Not compliance-certified.** No PCI, SOC 2 or ISO work has been done. Vyapio
  stores no card numbers — payment method is a label, not an instrument.
- **Local auth is not production auth.** It exists so the product runs without
  AWS, and production refuses to start with it.
- **Rate limiting is per-container.** The real ceiling scales with Lambda
  concurrency. API Gateway throttling is the durable control.
- **The QR trust model is modest, on purpose.** Possession of the printed token
  is the proof, like a loyalty card. It reveals nothing until the holder
  authenticates, but a photographed card could be claimed by whoever
  photographed it. A phone-OTP step would close that, and is not built.
- **Handwritten khata is out of scope.** Textract reads printed invoices.
  Handwriting recognition on mixed-script ledgers is not reliable enough to put
  near someone's accounts, and a confident wrong number is worse than no
  feature.

---

## Reporting something

Open a private issue, or contact the maintainers directly. Please do not file a
public issue for a vulnerability.
