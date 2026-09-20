# Vyapio

**Your shop. Your memory. Your AI.**

Vyapio is an operating memory for a neighbourhood shop. It remembers customers,
records sales from speech, tracks what people owe, watches stock, and answers
questions about the shop's own history — so the shopkeeper does not have to hold
all of it in their head.

**Scan → Identify → Record → Remember → Act.**

---

## Quick start

No AWS account needed. Everything below runs on a laptop.

### With Docker — nothing else to install

```bash
docker compose up
```

Open <http://localhost:8080>. The app builds itself, seeds the demo shop on
first start, and keeps its records in a named volume, so `docker compose down`
and a laptop restart both leave the shop where it was. `docker compose down -v`
is the one that wipes it.

### With Node — for working on the code

```bash
npm install
npm run seed          # builds the demo shop, Sharma Stores
npm run dev           # API on :4000, app on :5173
```

`.env` is optional: without one the app runs on built-in defaults and stores
everything in a local file. Copy `.env.example` to `.env` only when connecting
real AWS services.

Then open <http://localhost:5173> (or :8080 under Docker) and click **Try the
demo shop**, or sign in with:

```
demo@vyapio.app
VyapioDemo#2024
```

The demo shop has 5 customers, ~120 sales, 10 products, unpaid balances, and
orders waiting for collection — enough for every screen to have something real
in it. The customer list is `FEATURED_CUSTOMERS` in `backend/scripts/seed.ts`;
add names there and re-seed to grow the shop.

> **One thing to know up front.** With no AWS configured, Vyapio runs every
> subsystem locally: a file-backed store instead of DynamoDB, its own session
> tokens instead of Cognito, a rule-based parser instead of Bedrock. The app
> says so, on every screen, in a **Local mode** badge. Nothing local is ever
> presented as though it reached AWS. Fill in `.env` to switch any subsystem
> over — they flip independently.

---

## What it does

| | |
| --- | --- |
| **Scan a customer** | A QR code brings up everything the shop knows about them. The code holds a random token and nothing else — no name, no number, no balance. |
| **Speak a sale** | *"Ramesh ko 2 kilo chawal diya. 300 UPI kiya aur 120 baaki hai."* → a priced, checked draft the shopkeeper confirms before anything is written. |
| **Customer memory** | Every visit, rupee and promise as a timeline, not a ledger. |
| **Shop Pulse** | *What needs my attention today?* — stock running out, money overdue, orders ready. |
| **Shop Memory** | *"Who bought rice and oil together?"* Answered from the shop's own records, with the receipts shown underneath. |
| **Vyapio AI** | Finds overdue customers and drafts reminders. It cannot send one without a human tapping Confirm. |
| **Works offline** | Record a sale with no signal. It says "waiting to sync" — never "saved" — until the server confirms it. |
| **Seven languages** | English, Hindi, Bengali, Tamil, Telugu, Marathi, Kannada. The voice language is separate from the interface language. |
| **Customer app** | What I owe, where, and what I bought — across every Vyapio shop. |

---

## Architecture

```
          Shopkeeper PWA          Customer PWA
                    └──────┬──────┘
                    React + Vite + Tailwind
                           │
                    Amazon Cognito
                           │
                     API Gateway (HTTP)
                           │
              ┌────────────────────────┐
              │  ONE Lambda (Docker)   │
              │  /customers /khata     │
              │  /voice /search /agent │
              └───────────┬────────────┘
       ┌──────────────────┼──────────────────┐
   DynamoDB              S3               Bedrock
                          │            ┌────┼────┐
                      Textract      parse  KB  AgentCore
                                             │
                                       EventBridge → SNS
```

Full detail, and the reasoning behind each choice, in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Repository

```
backend/          One Lambda, packaged as a Docker image
  src/routes/       HTTP routes
  src/services/     Domain + AWS adapters (each has a local counterpart)
  src/schemas/      Zod schemas — shared with the frontend via @shared
  src/middleware/   Auth, validation, errors, rate limiting
frontend/         React + Vite PWA
  src/features/     One folder per product area
  src/components/   ui · layout · motion · charts · character
  src/locales/      Seven languages
infrastructure/   AWS CDK v2
docs/             Architecture, AWS setup, demo script, security
```

One detail worth noting: `frontend` imports its types from
`backend/src/schemas` through the `@shared` alias. There is one definition of a
Transaction, used both by the validator that guards the database and by the form
that collects it — so a contract change breaks the build rather than production.

---

## Commands

```bash
npm run dev              # API + app together
npm run dev:backend      # API only,  :4000
npm run dev:frontend     # app only,  :5173

npm run seed             # rebuild the demo shop
npm run seed -- --reset  # wipe first

npm run typecheck        # all three workspaces
npm run lint
npm test                 # 155 tests
npm run build
npm run verify           # all of the above — run before pushing

npm run docker:build     # build the Lambda image
npm run cdk:synth
npm run cdk:diff
npm run cdk:deploy
```

VS Code users get these as tasks (**Ctrl/Cmd+Shift+P → Run Task**) and two
debug configurations, including one that attaches to the API with breakpoints in
TypeScript source.

---

## Configuration

Everything lives in `.env`, documented inline in
[`.env.example`](.env.example). Nothing is required to run locally.

| Set this | To get |
| --- | --- |
| `DYNAMODB_TABLE_NAME` | Real DynamoDB instead of the local file store |
| `USER_POOL_ID` + `USER_POOL_CLIENT_ID` | Real Cognito instead of local dev auth |
| `S3_BUCKET_NAME` | Voice recordings and document uploads |
| `BEDROCK_ENABLED=true` | AI transaction parsing, Pulse narration, grounded answers |
| `BEDROCK_KNOWLEDGE_BASE_ID` | Semantic retrieval for Shop Memory |
| `AGENTCORE_RUNTIME_ARN` | Agent planning on Bedrock AgentCore |
| `TRANSCRIBE_ENABLED=true` | Amazon Transcribe instead of the browser's recogniser |
| `TEXTRACT_ENABLED=true` | Reading printed invoices |
| `EVENT_BUS_NAME` | EventBridge instead of in-process dispatch |
| `NOTIFICATION_PROVIDER=sns` | Reminders that actually reach customers |

Anything prefixed `VITE_` is compiled into the browser bundle and is public.
Secrets never go there, and none are read there.

---

## Deploying

Read [docs/AWS_SETUP.md](docs/AWS_SETUP.md) before running `cdk deploy` — it
covers bootstrapping, Bedrock model access, region availability, and what each
stack will cost you.

The short version:

```bash
aws sts get-caller-identity     # check the account first
cd infrastructure
npx cdk bootstrap               # once per account and region
npx cdk diff                    # read this before deploying
npx cdk deploy --all
```

CDK builds `backend/Dockerfile`, pushes it to ECR and wires the Lambda to it. No
console steps.

---

## What is not finished

Stated plainly, because a list of caveats is more useful than a list of ticks.

- **Docker image not built here.** Docker is not installed on this machine, so
  `docker build` has never run. The Dockerfile's build steps were executed
  directly (`npm ci` → `tsc` → `esbuild`) and the resulting bundle was invoked
  as a Lambda handler successfully, but the image itself is unverified.
- **Never deployed to AWS.** No AWS CLI or credentials here. `cdk synth`
  produces all eight stacks cleanly; `cdk deploy` has not been run.
- **Knowledge Base and AgentCore are wired, not provisioned.** Both need
  standing paid infrastructure (a vector store starts around $300/month), so
  CDK creates the IAM and leaves the resources to you. Setting the two
  environment variables activates them. Until then Shop Memory uses
  deterministic retrieval — still fully grounded, because grounding comes from
  citing real rows, not from a vector store.
- **Translation coverage is uneven.** English and Hindi are complete. The other
  five cover navigation, home, scanner, voice, money and offline status, and
  fall back to English elsewhere — visible as a bilingual screen, never a raw
  key.
- **No video asset.** The landing page's `AmbientLoop` renders an illustrated
  poster; drop an MP4 into `frontend/public/videos/` (spec in the README there)
  and it plays.
- **Handwritten khata is out of scope.** Textract reads printed invoices and
  receipts. Handwriting recognition on mixed-script ledgers is not reliable
  enough to put near someone's accounts, and the UI says so rather than
  producing confident nonsense.

---

## Testing

```
backend    119 tests   tenancy · ledger · auth · voice · agent · inventory · sync · search
frontend    36 tests   offline queue · money formatting · components · a11y · i18n
```

The tests worth reading first are `backend/tests/tenancy.test.ts` — which
attacks cross-shop access from every angle a client controls — and
`backend/tests/agent.test.ts`, which pins the three properties a clever model
must not be able to talk its way past.

---

## Docs

| | |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it fits together, and why |
| [AWS_SETUP.md](docs/AWS_SETUP.md) | Getting it onto AWS |
| [DEMO.md](docs/DEMO.md) | The three-minute demo, scene by scene |
| [SECURITY.md](docs/SECURITY.md) | Tenancy, secrets, and the AI confirmation model |

---

**Vyapio** — *My shop remembers for me.*
