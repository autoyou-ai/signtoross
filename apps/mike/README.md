# Mike

Mike is a legal document assistant with a Next.js frontend, an Express backend, Supabase Auth/Postgres, and Cloudflare R2-compatible object storage.

Website: [mikeoss.com](https://mikeoss.com)

## Contents

- `frontend/` - Next.js application
- `backend/` - Express API, Supabase access, document processing, and database schema
- `backend/schema.sql` - Supabase schema for fresh databases
- `backend/migrations/` - incremental database updates for existing deployments

## Prerequisites

- Node.js 20 or newer
- npm
- git
- A Supabase project
- A Cloudflare R2 bucket or Supabase local storage's S3-compatible endpoint
- At least one supported model provider: Anthropic, Google Gemini, OpenAI, or a local Ollama model
- LibreOffice installed locally if you need DOC/DOCX to PDF conversion
- An OpenSign instance. Mike supports the OpenSign token API and a Docker self-host mode that talks to the local Parse API.

## Local Storage

Mike uses S3-compatible object storage through the `R2_*` env vars. This
workspace uses Supabase local storage's S3 endpoint, so no separate object
storage container is required.

This Windows workspace is currently shaped for Supabase local storage:

```bash
SUPABASE_URL=http://127.0.0.1:54321
R2_ENDPOINT_URL=http://127.0.0.1:54321/storage/v1/s3
R2_BUCKET_NAME=mike
```

For production, point `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME` at Cloudflare R2 or another
managed S3-compatible storage service before running persisted signing checks.

## Database Setup

For a new Supabase database, open the Supabase SQL editor and run:

```sql
-- copy and run the contents of:
-- backend/schema.sql
```

The schema file is based on `supabase-migration.sql` and folds in the later files in `backend/migrations/`.

For an existing database, do not run the full schema file over production data. Apply the incremental files in `backend/migrations/` instead.

## Environment

Create local env files:

```bash
touch backend/.env
touch frontend/.env.local
```

Create `backend/.env`:

```bash
PORT=3001
FRONTEND_URL=http://localhost:3000
MIKE_PUBLIC_API_BASE_URL=https://api.example.com
PUBLIC_WEBHOOK_REQUIRED=false
DOWNLOAD_SIGNING_SECRET=replace-with-a-random-32-byte-hex-string
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-supabase-service-role-key

R2_ENDPOINT_URL=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=mike

GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key

# Local model provider. Use AI_PROVIDER=ollama to match the wider AutoYou
# runtime, or OLLAMA_ENABLED=true for a Mike-only deployment.
OLLAMA_ENABLED=false
# AI_PROVIDER=ollama
OLLAMA_API_BASE=http://127.0.0.1:11434
# OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=ministral-3:8b
OLLAMA_CLOUD_FALLBACK=true
OLLAMA_FALLBACK_MODEL=gemini-3-flash-preview
AUTOYOU_ADMIN_API_BASE=http://127.0.0.1:8001
AUTOYOU_CHAT_API_BASE=http://127.0.0.1:8081
AUTOYOU_RUNTIME_REQUIRED=false
AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED=false

RESEND_API_KEY=your-resend-key
USER_API_KEYS_ENCRYPTION_SECRET=your-long-random-secret

SIGNING_PROVIDER=opensign
OPENSIGN_API_MODE=token
OPENSIGN_API_BASE_URL=https://sign.example.com/api/v1.2
OPENSIGN_API_TOKEN=your-opensign-x-api-token
OPENSIGN_WEBHOOK_SECRET=your-opensign-webhook-security-key

# Docker self-host mode without OpenSign API-token access:
# OPENSIGN_API_MODE=selfhost
# OPENSIGN_PARSE_BASE_URL=http://127.0.0.1:3051/api/app
# OPENSIGN_PUBLIC_URL=https://sign.example.com
# OPENSIGN_PARSE_HOST_HEADER=sign.example.com
# OPENSIGN_PARSE_APP_ID=opensign
# OPENSIGN_PARSE_MASTER_KEY=your-self-hosted-parse-master-key
# OPENSIGN_ADMIN_EMAIL=admin@example.com
# OPENSIGN_ADMIN_PASSWORD=your-local-opensign-admin-password
# OPENSIGN_SELFHOST_SEND_EMAIL=true
# OPENSIGN_SELFHOST_REQUIRE_EMAIL=false
```

Create `frontend/.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=your-supabase-anon-key
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

Supabase values come from the project dashboard. Use the project URL for `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`, the service role key for the backend `SUPABASE_SECRET_KEY`, and the anon/public key for `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`. If your Supabase project shows multiple key formats, use the legacy JWT-style anon and service role keys expected by the Supabase client libraries.

Provider keys are only needed for the cloud models and email features you plan to use. Model provider keys can be configured in `backend/.env` for the whole instance, or per user in **Account > Models & API Keys**. If a provider key is present in `backend/.env`, that provider is available by default and the matching browser API key field is read-only.

Local legal model generation uses Ollama through the backend. Mike accepts the wider AutoYou runtime variables `AI_PROVIDER=ollama`, `OLLAMA_API_BASE`, and `OLLAMA_MODEL`; it also accepts `OLLAMA_ENABLED=true` and `OLLAMA_BASE_URL` for Mike-only deployments. If `OLLAMA_ENABLED=false` is present, it disables Ollama even when `AI_PROVIDER=ollama`. If `OLLAMA_CLOUD_FALLBACK=true`, Mike falls back to `OLLAMA_FALLBACK_MODEL` when Ollama fails before any stream output is sent.

For AutoYou SignToROSS runtime alignment, keep `AI_PROVIDER=ollama`, `OLLAMA_API_BASE`, and `OLLAMA_MODEL` shared with the broader AutoYou runtime. `AUTOYOU_ADMIN_API_BASE` lets Mike's integration doctor probe the AutoYou admin status API, which defaults to `http://127.0.0.1:8001`; `AUTOYOU_CHAT_API_BASE` points to AutoYou's `/api/chat` API, which defaults to `http://127.0.0.1:8081`. Set `AUTOYOU_RUNTIME_REQUIRED=true` and `AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED=true` when that runtime must be online for the current test gate.

Signature requests use OpenSign. `OPENSIGN_API_MODE=token` uses the documented OpenSign API and requires `OPENSIGN_API_TOKEN`. `OPENSIGN_API_MODE=selfhost` is for a Docker OpenSign deployment without paid API-token access; it uses the local Parse API, creates documents, returns signing links, sends recipient emails through OpenSign's configured mail provider, and downloads signed PDFs through the local OpenSign file route. Configure outbound email delivery inside OpenSign itself, for example with the Gmail account you want sender emails to come from. For Gmail SMTP in OpenSign, set `SMTP_ENABLE=true`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER_EMAIL`, `SMTP_USERNAME`, and a Google app password in `SMTP_PASS`.

When `PUBLIC_WEBHOOK_REQUIRED=true` or `NODE_ENV=production`, Mike rejects unsigned OpenSign webhooks unless `OPENSIGN_WEBHOOK_SECRET` is set and matches OpenSign.

## Install

Install each app package:

```bash
npm install --prefix backend
npm install --prefix frontend
```

## Run Locally

If `SUPABASE_URL` points at `127.0.0.1:54321`, start the local Supabase stack
first:

```bash
supabase start
```

Start the backend:

```bash
npm run dev --prefix backend
```

Start the main app:

```bash
npm run dev --prefix frontend
```

When you want an AutoYou SignToROSS-compatible runtime included in live
readiness checks, start your own admin/status service and `/api/chat` bridge in
another terminal, then point `AUTOYOU_ADMIN_API_BASE` and
`AUTOYOU_CHAT_API_BASE` at those HTTP endpoints. This repository does not
include or require private runtime source.

Open `http://localhost:3000`.

Quick local reachability checks from PowerShell:

```powershell
Invoke-WebRequest http://127.0.0.1:3000 -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:3001/health -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:3001/health/integrations -UseBasicParsing
npm run integration:live-preflight --prefix backend
```

If `127.0.0.1:3000` does not load in Chrome, first confirm that
`npm run dev --prefix frontend` is still running and has not moved to another
port. If the PowerShell request returns `200` but a browser-control plugin cannot
load it, the app is reachable and the failure is in the plugin/browser session,
not in Mike.

## First Run

1. Sign up in the app.
2. If you did not set cloud provider keys or enable Ollama in `backend/.env`, open **Account > Models & API Keys** and add an Anthropic, Gemini, or OpenAI API key.
3. Create or open a project and start chatting with documents.

## Troubleshooting

**Sign-up confirmation email never arrives.** Confirmation emails are sent by Supabase Auth, not by Mike. For local development, the simplest fix is to disable email confirmation in **Supabase > Authentication > Providers > Email**. For production, configure custom SMTP in Supabase; the built-in mailer is heavily rate-limited and may be restricted on newer projects.

**The model picker shows a missing-key or unavailable-model warning.** Add a key for that cloud provider in **Account > Models & API Keys**, configure the provider key in `backend/.env`, or enable Ollama with `AI_PROVIDER=ollama` or `OLLAMA_ENABLED=true` plus `OLLAMA_MODEL`.

**DOC or DOCX conversion fails.** Install LibreOffice locally and restart the backend so document conversion commands are available on the process path.

**`127.0.0.1:3000` does not load.** Port `3000` is the Next.js frontend, not the
backend. Start `npm run dev --prefix frontend`, then check
`Invoke-WebRequest http://127.0.0.1:3000 -UseBasicParsing`. The backend health
check is `http://127.0.0.1:3001/health`. If a Chrome/plugin view fails while the
PowerShell request succeeds, restart that browser/plugin session or open
`http://localhost:3000` directly.

## Useful Checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run smoke:adapters --prefix backend
npm run integration:positive-loop --prefix backend
npm run integration:full-local-loop --prefix backend
npm run integration:goal-audit --prefix backend
npm run integration:doctor --prefix backend
npm run integration:ollama-legal-preflight --prefix backend
npm run integration:ollama-fallback-smoke --prefix backend
npm run integration:live-preflight --prefix backend
npm run integration:doctor-all-green-smoke --prefix backend
npm run integration:autoyou-signtoross-smoke --prefix backend
npm run integration:webhook-public-rejection --prefix backend
npm run integration:persisted-smoke --prefix backend
npm run integration:api-smoke --prefix backend
npm run integration:generated-signing-smoke --prefix backend
npm run integration:chat-generated-signing-smoke --prefix backend
npm run integration:chat-generated-webhook-smoke --prefix backend
npm run integration:opensign-live --prefix backend
npm run integration:signature-watch --prefix backend -- --request-id <id> --watch --sync
npm run lint --prefix frontend
```

`integration:positive-loop` is the top-level local reinforcement loop: it runs builds, adapter smoke, Ollama legal-model preflight, Ollama cloud-fallback boundary smoke, AutoYou SignToROSS mock bridge smoke, the all-green doctor smoke, authenticated signing API smoke, persisted signature watcher smoke, generated-document signing, chat-generated webhook signing, public webhook readiness, and then prints the doctor live-readiness summary. Use `integration:positive-loop:fast` to skip the frontend build and duplicate provider-sync chat smoke during faster iteration. `integration:full-local-loop` is the shorter acceptance gate for the specific end-to-end objective: local Ollama legal output, cloud fallback boundary behavior, AutoYou SignToROSS advice contract, generated document, OpenSign webhook completion, signature monitoring, and public webhook fail-closed behavior. `integration:goal-audit` first records separate local Ollama/no-cloud-fallback and cloud-fallback-boundary gates, then runs the full local loop, then runs strict live preflight; it exits nonzero until live AutoYou, OpenSign API, OpenSign webhook secret, and public HTTPS callback routing are all proven. Set `GOAL_AUDIT_JSON=true` for a machine-readable requirement report on Windows. `smoke:adapters` uses mock OpenSign and Ollama services. `integration:ollama-legal-preflight` forces cloud fallback off and verifies the selected local Ollama model answers OpenSign-aware legal prompts without drifting to cloud providers or other signing services. `integration:ollama-fallback-smoke` points Ollama at a closed local port and clears the Gemini key to prove local-only mode does not call cloud fallback, Ollama fallback targets are rejected, and explicit cloud fallback selects Gemini only after Ollama fails before output. `integration:doctor` checks live-readiness gates without sending signature emails, including Supabase reachability, document/signature tables, storage write/signed-URL readiness, Ollama legal advice, AutoYou SignToROSS runtime alignment, and the AutoYou `/api/chat` legal-advice bridge. `integration:live-preflight` wraps the doctor in strict public/live mode by making public webhook, AutoYou runtime, and AutoYou SignToROSS advice warnings hard failures without sending a document. `integration:doctor-all-green-smoke` wraps the real doctor with mock Ollama, OpenSign, AutoYou admin/chat, and public webhook env to prove every doctor gate can pass locally. `integration:autoyou-signtoross-smoke` uses mock AutoYou admin and chat servers to verify Mike can discover the runtime, share the Ollama env contract, and request OpenSign-aware legal advice through the AutoYou chat API. `integration:webhook-public-rejection` starts Mike in public webhook mode, proves unsigned OpenSign callbacks are rejected before event recording, then proves a configured public webhook health report is ready for public signing. `integration:persisted-smoke` uses local Supabase/storage plus mock OpenSign to verify stored generated documents, signature rows, provider sync, signed-PDF import, signed URL generation, and `integration:signature-watch --json` monitoring output. `integration:api-smoke` adds the authenticated Mike API layer by creating a disposable local auth user and exercising create, list, sync, detail, and signed-url routes. `integration:generated-signing-smoke` generates a first-class DOCX document, verifies its PDF rendition, then sends and syncs that generated document through the authenticated signing API using mock OpenSign. `integration:chat-generated-signing-smoke` drives the authenticated `/chat` route with a mock Ollama tool loop, verifies `generate_docx` and `read_document` tool execution, then signs and syncs that chat-generated document through mock OpenSign. `integration:chat-generated-webhook-smoke` runs the same chat-generated document flow, completes it through a signed OpenSign webhook callback, records the webhook event, updates the recipient, imports the signed PDF, and verifies the signed URL. `integration:opensign-live` dry-runs by default; setting `LIVE_SIGNING_SEND=true` sends one real OpenSign probe to `LIVE_SIGNING_TEST_EMAIL`; in public/production mode it refuses to send unless the OpenSign webhook secret and public HTTPS Mike callback URL are configured. `integration:signature-watch` watches a Mike-created signature request, recipient status, webhook events, and signed-PDF import; set `SIGNATURE_WATCH_JSON=true` for a machine-readable monitoring snapshot. With the backend running, `GET http://localhost:3001/health/integrations` checks OpenSign configuration, public webhook readiness, and Ollama reachability/model installation without sending documents or emails.

For the step-by-step OpenSign/Ollama live loop, see `docs/opensign-ollama-live-loop.md`.
