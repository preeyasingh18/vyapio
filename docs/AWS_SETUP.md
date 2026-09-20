# AWS setup

Getting Vyapio onto AWS. Read this before `cdk deploy` — it creates real
resources that cost real money, and a couple of the steps cannot be undone
cheaply.

> **Nothing here is required to run Vyapio.** `npm run dev` works with no AWS
> account. Follow this only when you want the real services.

---

## 1. Prerequisites

```bash
node --version     # 20.19+
docker --version   # required: CDK builds the Lambda image
aws --version      # AWS CLI v2
```

If you do not have the AWS CLI:

- macOS: `brew install awscli`
- Windows: `winget install Amazon.AWSCLI`
- Linux: <https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html>

Docker must be **running**, not merely installed — CDK builds
`backend/Dockerfile` during `cdk deploy`.

---

## 2. Credentials

```bash
aws configure
```

Then confirm you are pointed where you think you are. This is the step people
skip and regret:

```bash
aws sts get-caller-identity
```

```json
{
  "UserId": "AIDA...",
  "Account": "123456789012",
  "Arn": "arn:aws:iam::123456789012:user/you"
}
```

**Check that account number.** Deploying to the wrong account is a bad hour.

```bash
aws configure get region     # should be ap-south-1, or whatever you intend
```

With several profiles:

```bash
export AWS_PROFILE=vyapio
aws sts get-caller-identity --profile vyapio
```

### Permissions

The deploying identity needs to create resources across CloudFormation, IAM,
Lambda, ECR, API Gateway, DynamoDB, S3, Cognito, EventBridge, SNS, SQS,
CloudFront and CloudWatch Logs. `AdministratorAccess` is simplest for a
hackathon account. For anything longer-lived, scope it down — CDK's bootstrap
roles are a reasonable starting point.

---

## 3. Region

Default: **ap-south-1 (Mumbai)** — nearest to the users, and it keeps a shop's
customer data in-country.

The complication is that **Bedrock is not available in every region**, and model
availability varies within the regions that do have it. So the inference region
is configured separately from the data plane.

**Check before you enable anything:**

```bash
# Is Bedrock available in this region at all?
aws bedrock list-foundation-models --region ap-south-1 --query 'modelSummaries[?contains(modelId, `anthropic`)].modelId' --output table

# Which cross-region inference profiles exist?
aws bedrock list-inference-profiles --region ap-south-1 --output table
```

If Bedrock is not offered there, keep the data plane in Mumbai and point
inference elsewhere:

```bash
npx cdk deploy --all -c bedrockRegion=us-east-1
```

Cross-region inference profiles carry a prefix that must match the region group:

| Region group | Prefix | Example |
| --- | --- | --- |
| Asia-Pacific | `apac.` | `apac.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| US | `us.` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| Europe | `eu.` | `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` |

Using the wrong prefix produces a `ValidationException` at invoke time, not at
deploy time — so verify it now rather than during a demo.

### Model access

Bedrock models need explicit access before first use:

1. Bedrock console → **Model access**
2. **Manage model access** → tick the Anthropic models
3. Submit. Most grants are immediate; some take a few minutes.

Confirm before enabling in CDK:

```bash
aws bedrock-runtime converse \
  --region ap-south-1 \
  --model-id apac.anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --messages '[{"role":"user","content":[{"text":"ping"}]}]' \
  --inference-config '{"maxTokens":10}'
```

A reply means you are ready. An `AccessDeniedException` means access has not
been granted for that model in that region.

**Vyapio works without any of this.** With `BEDROCK_ENABLED=false` it uses its
deterministic parser and says so in the UI.

---

## 4. Bootstrap

Once per account *and* region:

```bash
cd infrastructure
npx cdk bootstrap aws://123456789012/ap-south-1
```

This creates the CDK toolkit stack: an S3 bucket for assets, an ECR repository
for images, and the deployment roles.

---

## 5. Deploy

**Look at the diff first.** Always.

```bash
npx cdk synth          # does it render?
npx cdk diff           # what would change?
npx cdk deploy --all
```

Ten to fifteen minutes on a first deploy. CloudFront is most of it.

### Outputs

Keep these — the next steps need them:

```
Vyapio-dev-Database.TableName          → DYNAMODB_TABLE_NAME
Vyapio-dev-Cognito.UserPoolId          → USER_POOL_ID / VITE_COGNITO_USER_POOL_ID
Vyapio-dev-Cognito.UserPoolClientId    → USER_POOL_CLIENT_ID / VITE_COGNITO_CLIENT_ID
Vyapio-dev-Storage.BucketName          → S3_BUCKET_NAME
Vyapio-dev-Events.EventBusName         → EVENT_BUS_NAME
Vyapio-dev-Events.TopicArn             → SNS_TOPIC_ARN
Vyapio-dev-Api.ApiUrl                  → VITE_API_URL
Vyapio-dev-Frontend.AppUrl             → the app
Vyapio-dev-Frontend.WebBucketName      → upload target
Vyapio-dev-Frontend.DistributionId     → cache invalidation
```

### The second deploy

CORS and S3 both need the app's origin, but the CloudFront domain does not exist
until the frontend stack has been created. So the first deploy allows localhost
only. Once you have the URL:

```bash
npx cdk deploy --all -c appOrigin=https://d1234abcd.cloudfront.net
```

---

## 6. Ship the frontend

```bash
cd frontend
VITE_API_URL=https://abc123.execute-api.ap-south-1.amazonaws.com \
VITE_COGNITO_USER_POOL_ID=ap-south-1_XXXXXXXXX \
VITE_COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx \
VITE_AWS_REGION=ap-south-1 \
npm run build

aws s3 sync dist/ s3://vyapio-web-dev-123456789012-ap-south-1 --delete
aws cloudfront create-invalidation --distribution-id E1XXXXXXXXXXXX --paths '/*'
```

`--delete` matters: stale hashed assets accumulate otherwise, and a service
worker can pin a visitor to them.

---

## 7. Seed the demo shop

With Cognito live, the seed script cannot create the user — the API deliberately
holds no `cognito-idp:Admin*` permissions. Sign up through the app first, then:

```bash
DYNAMODB_TABLE_NAME=vyapio-dev \
AWS_REGION=ap-south-1 \
DEMO_USER_ID=<the Cognito sub> \
npm run seed --workspace backend
```

Find the sub with:

```bash
aws cognito-idp list-users --user-pool-id ap-south-1_XXXXXXXXX \
  --query 'Users[].Attributes[?Name==`sub`].Value' --output text
```

---

## 8. Optional services

Each of these is off by default. Vyapio works without all of them and tells the
user which are missing.

### Transcribe — streaming voice

```bash
npx cdk deploy --all -c transcribeEnabled=true
```

Better accuracy on Indian languages and code-switched speech than the browser's
recogniser. Without it, the UI names the browser engine explicitly.

### Textract — printed invoices

```bash
npx cdk deploy --all -c textractEnabled=true
```

Printed invoices and receipts only. Vyapio does not claim to read handwritten
khata pages — recognition on mixed-script ledgers is not reliable enough to put
near someone's accounts, and the UI says so rather than producing confident
nonsense.

### SNS — reminders that actually send

```bash
npx cdk deploy --all -c notificationProvider=sns
```

**Read this before demoing it.** New AWS accounts are in the SMS sandbox, where
messages only reach verified numbers:

```bash
aws sns create-sms-sandbox-phone-number --phone-number +919876543210
aws sns verify-sms-sandbox-phone-number --phone-number +919876543210 --one-time-password 123456
```

India also requires DLT registration for commercial SMS. Until both are sorted,
leave `NOTIFICATION_PROVIDER=mock` — reminders are recorded and honestly
reported as **not delivered**, which is the right behaviour, not a limitation.

### Knowledge Base — semantic Shop Memory

CDK creates the IAM role and leaves the rest to you, deliberately: a Knowledge
Base needs a vector store, and every managed option bills hourly whether or not
anybody asks a question (OpenSearch Serverless is roughly **$300/month** at
minimum capacity). That is not something to provision from a template.

1. Bedrock console → **Knowledge bases** → Create
2. IAM role: use `Vyapio-dev-Ai.KnowledgeBaseRoleArn`
3. Data source: `s3://vyapio-dev-.../knowledge-base/`
4. Embeddings: Titan Text Embeddings V2
5. Vector store: OpenSearch Serverless (quick create), or Aurora Serverless v2
6. Sync, then:

```bash
npx cdk deploy --all -c knowledgeBaseId=ABCD1234
```

Without it, Shop Memory uses deterministic retrieval — still fully grounded,
because grounding comes from citing real rows, not from a vector store.

### AgentCore — hosted agent planning

```bash
npx cdk deploy --all -c agentRuntimeArn=arn:aws:bedrock-agentcore:...
```

Tool *execution* stays in the Lambda on purpose: the vendorId comes from the
request's session, so authorization cannot be influenced by anything the agent
decides. The runtime plans; Vyapio still enforces.

---

## 9. Costs

Rough monthly figures for a single shop's traffic, ap-south-1, USD.

| | |
| --- | --- |
| DynamoDB (on-demand) | < $1 |
| Lambda (ARM, 1024 MB) | < $1 — comfortably inside the free tier |
| API Gateway HTTP | < $1 |
| S3 + CloudFront | ~$1 |
| Cognito | free to 50,000 MAU |
| EventBridge + SNS + SQS | < $1 |
| ECR | ~$0.10 per GB |
| **Subtotal** | **~$3–5** |
| Bedrock | per token, ~$1–5 at demo volumes |
| Transcribe | ~$0.024/minute |
| Textract AnalyzeExpense | ~$0.01/page |
| **Knowledge Base vector store** | **~$300+** ← the one to watch |

Everything except the vector store is small. That one is not.

### Tearing down

```bash
npx cdk destroy --all
```

In `dev` this removes everything. In `staging`/`prod` the table, user pool and
buckets are **retained** by design — losing a shop's ledger to a `cdk destroy`
typo is not a recoverable mistake. Delete them by hand if you mean it.

---

## Troubleshooting

**`docker: command not found` during deploy**
CDK builds the Lambda image. Install Docker and make sure the daemon is running.

**`ValidationException: The provided model identifier is invalid`**
Wrong inference-profile prefix for the region group, or access not granted. See
§3.

**`AccessDeniedException` calling Bedrock**
Model access is per-model *and* per-region. Grant it in the console for the
region in `bedrockRegion`.

**CORS errors in the browser**
The first deploy only allows localhost. Redeploy with
`-c appOrigin=https://<your-cloudfront-domain>`.

**`Export cannot be deleted as it is in use`**
A cross-stack reference. Deploy in dependency order, or
`cdk deploy --all --exclusively` for one stack.

**The PWA is stuck on an old build**
A cached service worker. `/sw.js` and `/index.html` are served with
`no-cache`; invalidate CloudFront after uploading, and hard-reload once.

**`cdk bootstrap` fails on permissions**
The bootstrap stack needs IAM and S3 creation rights. Use an admin identity for
this one step.
