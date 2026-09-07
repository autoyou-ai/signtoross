# OpenSign and Ollama Live-Test Loop

Use this loop when moving from mock verification to live signing and local legal-model generation.

## Local positive loop

Run this after code or config changes when you want one command to re-prove the local path and then print the next live gate:

```bash
npm run integration:positive-loop --prefix backend
```

For faster inner-loop checks:

```bash
npm run integration:positive-loop:fast --prefix backend
```

For a concise acceptance gate that maps directly to the requested local
OpenSign/Ollama/SignToROSS workflow, run:

```bash
npm run integration:full-local-loop --prefix backend
```

To audit the whole objective, including live-only gates, run:

```bash
npm run integration:goal-audit --prefix backend
```

That command runs the full local acceptance loop, then runs strict live
preflight. It exits nonzero until live AutoYou, OpenSign API reachability,
OpenSign webhook HMAC, and the public HTTPS Mike callback route are all proven.
The first requirement in the report is a separate local Ollama/no-cloud-fallback
gate with the resolved Ollama base URL, model, install status, and version.
Use `GOAL_AUDIT_JSON=true` for a machine-readable requirement report on
Windows:

```powershell
$env:GOAL_AUDIT_JSON='true'
npm run integration:goal-audit --prefix backend
Remove-Item Env:GOAL_AUDIT_JSON
```

Green local steps mean Mike still builds, talks to mock Ollama/OpenSign, verifies the selected local Ollama model with cloud fallback disabled, verifies the AutoYou SignToROSS `/api/chat` contract, generates signable documents, imports signed PDFs through webhook completion, verifies the signature watcher JSON monitor, and can summarize any remaining live-only gates.
It also proves the cloud fallback boundary behaves as expected and that public
webhook mode rejects unsigned OpenSign callbacks before recording signature
events.

To prove the readiness doctor can go fully green when live env values are present, run:

```bash
npm run integration:doctor-all-green-smoke --prefix backend
```

That smoke uses mock Ollama, OpenSign, AutoYou admin/chat, and a public webhook URL placeholder while still using local Supabase/storage.

## 0. Fast local adapter smoke

This does not call real OpenSign, send email, or run a local model. It proves the adapter contracts still work.

```bash
npm run smoke:adapters --prefix backend
npm run build --prefix backend
npm run build --prefix frontend
```

Green means:

- Ollama chat, completion, and tool-call loops work against a mock Ollama server.
- OpenSign document creation, signing-link capture, and signed-PDF download work against a mock OpenSign server.
- Backend and frontend TypeScript compile.

## 1. Persisted local signing smoke

This uses local Supabase/storage and a mock OpenSign server. It does not send email or require an OpenSign API token.

```bash
npm run integration:persisted-smoke --prefix backend
```

Green means Mike can store a generated PDF, create and list a signature request, sync provider completion, import the signed PDF, produce a signed URL for the completed file, and report the completed request through `integration:signature-watch --json`.

## 2. Authenticated API signing smoke

This starts an isolated local Mike API server on a random port, creates a disposable Supabase auth user, and exercises the same signing routes used by the frontend against mock OpenSign.

```bash
npm run integration:api-smoke --prefix backend
```

Green means the authenticated route layer can create, list, sync, inspect, and produce a signed URL for an OpenSign request.

## 3. Generated document signing smoke

This runs Mike's generated-DOCX path, verifies a PDF rendition was created for signing, then sends and syncs that generated document through the authenticated signing API using mock OpenSign.

```bash
npm run integration:generated-signing-smoke --prefix backend
```

Green means a document created by Mike can immediately enter the OpenSign signing flow without a manual re-upload or regeneration step.

## 4. Chat-route generated signing smoke

This drives the authenticated `/chat` route with a mock Ollama tool loop. The model emits `generate_docx`, then `read_document`, then final prose; the generated document is then sent through the signing API and synced through mock OpenSign.

```bash
npm run integration:chat-generated-signing-smoke --prefix backend
```

Green means the assistant route, Ollama tool-call plumbing, generated document persistence, signature send, status monitoring sync, and signed-PDF import all work together locally.

## 5. Chat-route webhook completion smoke

This runs the same chat-generated document flow, then completes the request through Mike's signed OpenSign webhook route instead of direct provider polling.

```bash
npm run integration:chat-generated-webhook-smoke --prefix backend
```

Green means the assistant route, generated document persistence, signature send, OpenSign webhook HMAC verification, webhook event recording, recipient completion update, signed-PDF import, and signed URL generation all work together locally.

## 6. AutoYou SignToROSS legal-advice smoke

This uses mock AutoYou admin and chat servers. It proves Mike can discover the AutoYou runtime, share the local Ollama env contract, and request OpenSign-aware legal advice through AutoYou's real `/api/chat` request/response shape.

```bash
npm run integration:autoyou-signtoross-smoke --prefix backend
```

Green means the SignToROSS bridge contract is stable before a live AutoYou process is required.

## 6a. Local Ollama legal-model preflight

This uses the configured live Ollama endpoint and selected model. It disables
cloud fallback for the process, asks OpenSign-aware legal drafting and
monitoring prompts, and fails if the response drifts to cloud providers or
other signing services.

```bash
npm run integration:ollama-legal-preflight --prefix backend
```

Use `-- --json` when another script should parse the model, base URL, answers,
and failed checks.

## 6b. Ollama cloud-fallback boundary

This does not call a real cloud model. It points Ollama at a closed local port
and clears the Gemini key for the process. It proves local-only mode does not
fall back to cloud APIs, rejects an Ollama model as a fallback target, and only
selects Gemini after Ollama fails before output when fallback is explicitly
enabled.

```bash
npm run integration:ollama-fallback-smoke --prefix backend
```

## 7. Public webhook readiness smoke

This starts Mike with `PUBLIC_WEBHOOK_REQUIRED=true` and no `OPENSIGN_WEBHOOK_SECRET`, posts an unsigned OpenSign webhook, and verifies Mike returns `401` without recording a `signature_events` row. It then sets a public HTTPS Mike URL, OpenSign configuration, and the webhook secret, and verifies `/health/integrations` reports `opensign.readyForPublicSigning=true`.

```bash
npm run integration:webhook-public-rejection --prefix backend
```

Green means the public/Cloudflare-facing webhook route fails closed when the shared OpenSign webhook secret has not been configured, and reports ready only when the public URL, OpenSign provider configuration, and webhook secret are all present.

## 8. Iterative readiness loop

Run the doctor after each config change:

```bash
npm run integration:doctor --prefix backend
```

The doctor is intentionally conservative. It:

- creates and validates a local DOCX package;
- checks Supabase and S3-compatible storage env needed for persisted generated documents and signed-PDF imports;
- probes Supabase reachability and the document/signature tables needed for monitoring;
- uploads and signs a temporary storage probe object so generated documents and signed PDFs can be written;
- forces a local Ollama advice smoke with cloud fallback disabled;
- checks that Mike is aligned with AutoYou SignToROSS local-model env conventions and optionally probes the AutoYou admin runtime;
- probes the AutoYou `/api/chat` legal-advice bridge when the runtime is available or required;
- checks whether the cloud fallback is configured;
- probes OpenSign API reachability without sending a document or email;
- verifies OpenSign webhook HMAC behavior.

When a gate is red or yellow, fix only that boundary, rerun the doctor, and
keep the prior green gates as your rollback point. Use `--json` when another
script should parse the result, and `--strict` when warnings should fail the
command.

Before opening a public route or sending a real request, run the strict live
preflight:

```bash
npm run integration:live-preflight --prefix backend
```

This forces `PUBLIC_WEBHOOK_REQUIRED=true`, `AUTOYOU_RUNTIME_REQUIRED=true`,
and `AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED=true` for the check. It does not send a
document or create a signature email. Green means the remaining live gates are
configured enough to move to a controlled OpenSign send.

## 9. Controlled OpenSign live loop

After the doctor reaches the OpenSign gate, configure either token mode or
self-host mode, plus a disposable test recipient:

```bash
OPENSIGN_API_MODE=token
OPENSIGN_API_TOKEN=your-opensign-x-api-token
OPENSIGN_WEBHOOK_SECRET=your-opensign-webhook-secret
LIVE_SIGNING_TEST_EMAIL=you@example.com
LIVE_SIGNING_TEST_NAME="Mike Test Signer"
```

For Docker self-host mode without OpenSign API-token access, use:

```bash
OPENSIGN_API_MODE=selfhost
OPENSIGN_PARSE_BASE_URL=http://127.0.0.1:3051/api/app
OPENSIGN_PUBLIC_URL=https://your-opensign-host
OPENSIGN_PARSE_HOST_HEADER=your-opensign-host
OPENSIGN_PARSE_APP_ID=opensign
OPENSIGN_PARSE_MASTER_KEY=your-self-hosted-parse-master-key
OPENSIGN_ADMIN_EMAIL=admin@example.com
OPENSIGN_ADMIN_PASSWORD=your-local-opensign-admin-password
OPENSIGN_WEBHOOK_SECRET=your-opensign-webhook-secret
OPENSIGN_SELFHOST_SEND_EMAIL=true
OPENSIGN_SELFHOST_REQUIRE_EMAIL=false
```

If this is a public or production send, also configure the public Mike callback
before sending:

```bash
MIKE_PUBLIC_API_BASE_URL=https://your-mike-api-host
PUBLIC_WEBHOOK_REQUIRED=true
OPENSIGN_WEBHOOK_SECRET=your-opensign-webhook-secret
```

The live runner refuses `--send` in public/production mode unless the webhook
secret is configured and `MIKE_PUBLIC_API_BASE_URL` is a non-local HTTPS URL.

Run the dry-run first:

```bash
npm run integration:opensign-live --prefix backend
```

When it says the live send is ready, send exactly one controlled probe:

```powershell
$env:LIVE_SIGNING_SEND='true'
npm run integration:opensign-live --prefix backend
Remove-Item Env:LIVE_SIGNING_SEND
```

This sends a real OpenSign request to `LIVE_SIGNING_TEST_EMAIL`. Record the
`Provider request id` from the output. Complete the signing flow in OpenSign,
then verify signed-PDF retrieval:

```powershell
$env:LIVE_SIGNING_PROVIDER_REQUEST_ID='<provider-request-id>'
npm run integration:opensign-live --prefix backend
Remove-Item Env:LIVE_SIGNING_PROVIDER_REQUEST_ID
```

Green means Mike's OpenSign adapter can create a real request, capture signing
links/status, and retrieve the completed signed PDF. The app UI/database flow is
the next gate after this provider-level live test.

After OpenSign SMTP/Mailgun is configured, require email delivery success during
the live send:

```powershell
$env:LIVE_SIGNING_SEND='true'
$env:LIVE_SIGNING_REQUIRE_EMAIL='true'
npm run integration:opensign-live --prefix backend
Remove-Item Env:LIVE_SIGNING_SEND
Remove-Item Env:LIVE_SIGNING_REQUIRE_EMAIL
```

With Docker self-host mode, this fails if OpenSign creates a signing link but
its mail function does not report `success`.

The Gmail helper also sets `OPENSIGN_SELFHOST_EMAIL_CONFIGURED=true` and
`OPENSIGN_SELFHOST_REQUIRE_EMAIL=true` in Mike's backend env. After that,
`/health/integrations` reports `opensign.readyForPublicEmailSigning=true` only
when the public signing route, webhook readiness, and self-host email readiness
are all configured. The strict live send above is still the actual delivery
proof.

To watch a Mike-created request after sending from the app, run one of:

```bash
npm run integration:signature-watch --prefix backend -- --request-id <signature-request-id> --watch --sync
npm run integration:signature-watch --prefix backend -- --document-id <document-id> --watch --sync
```

If npm does not forward script arguments in PowerShell, use the watcher env vars
instead:

```powershell
$env:SIGNATURE_REQUEST_ID='<signature-request-id>'
$env:SIGNATURE_WATCH='true'
$env:SIGNATURE_SYNC_PROVIDER='true'
npm run integration:signature-watch --prefix backend
```

This reads Mike's `signature_requests`, `signature_recipients`, and
`signature_events` rows, polls OpenSign directly when `--sync` is present, then
reports whether the signed PDF has been imported. Omit `--sync` for passive
database/webhook-only watching. Add `--show-links` only on a trusted local
terminal. Add `--json` when another script should parse status,
`ready_to_download`, recipient status, event types, and `next_action`.

## 10. Local Ollama setup

Pull or create the local legal model first:

```bash
ollama pull ministral-3:8b
```

Then set backend env:

```bash
AI_PROVIDER=ollama
OLLAMA_API_BASE=http://127.0.0.1:11434
OLLAMA_MODEL=ministral-3:8b
OLLAMA_CLOUD_FALLBACK=true
OLLAMA_FALLBACK_MODEL=gemini-3-flash-preview
AUTOYOU_ADMIN_API_BASE=http://127.0.0.1:8001
AUTOYOU_CHAT_API_BASE=http://127.0.0.1:8081
AUTOYOU_RUNTIME_REQUIRED=false
```

For a Mike-only deployment, `OLLAMA_ENABLED=true` can be used instead of
`AI_PROVIDER=ollama`, and `OLLAMA_BASE_URL` is accepted as an alias for
`OLLAMA_API_BASE`. If `OLLAMA_ENABLED=false` is present, remove it or change it
before testing because it explicitly disables the local provider.

For the broader AutoYou SignToROSS runtime, keep `AI_PROVIDER=ollama`,
`OLLAMA_API_BASE`, and `OLLAMA_MODEL` shared between Mike and AutoYou. The
doctor probes `AUTOYOU_ADMIN_API_BASE` for status/config and
`AUTOYOU_CHAT_API_BASE` for `/api/chat` legal advice. If the AutoYou runtime
must be online for a particular test, set `AUTOYOU_RUNTIME_REQUIRED=true` and
`AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED=true` so runtime reachability and SignToROSS advice become
hard gates instead of warnings.

For a local AutoYou-compatible runtime, start your own admin/status service and
`/api/chat` bridge in another terminal, then point `AUTOYOU_ADMIN_API_BASE` and
`AUTOYOU_CHAT_API_BASE` at those HTTP endpoints. This repository does not
include or require private runtime source.

Green live SignToROSS evidence means `npm run integration:live-preflight --prefix
backend` reports both `AutoYou SignToROSS runtime alignment` and `AutoYou SignToROSS legal
advice bridge` as passing. If those pass but live preflight still fails, the
remaining work is OpenSign/API/public callback configuration rather than local
Ollama or SignToROSS integration.

Restart the backend and check:

```bash
curl http://localhost:3001/health/integrations
```

Green means `ollama.configured`, `ollama.reachable`, and `ollama.modelInstalled` are all true.

## 11. Live OpenSign setup

Configure OpenSign itself with the sender email and SMTP settings, such as `admin@example.com`.

The official Docker guide is here:
https://docs.opensignlabs.com/docs/self-host/docker/run-locally/

For a local Windows Docker trial, OpenSign's documented PowerShell flow downloads
`docker-compose.yml`, `Caddyfile`, and `.env.local_dev`, renames the env file to
`.env.prod`, then runs `docker compose up --force-recreate`. The local app is
documented as `https://localhost:3001`.

That local OpenSign default conflicts with Mike backend's default `PORT=3001`.
For side-by-side testing on this Windows machine, either move Mike to another
port, for example `PORT=3002` plus `NEXT_PUBLIC_API_BASE_URL=http://localhost:3002`,
or change the OpenSign compose/Caddy port before starting it.

For a public deployment, put OpenSign behind your own HTTPS host and keep
MongoDB private. OpenSign's Docker docs warn that the default MongoDB
configuration does not enable authentication, so port `27017` must not be
exposed to the internet. Keep provider-specific DNS records and routing
configuration outside this repository.

Set backend env:

```bash
MIKE_PUBLIC_API_BASE_URL=https://your-mike-api-host
PUBLIC_WEBHOOK_REQUIRED=true
SIGNING_PROVIDER=opensign
OPENSIGN_API_MODE=token
OPENSIGN_API_BASE_URL=https://your-opensign-host/api/v1.2
OPENSIGN_API_TOKEN=your-opensign-x-api-token
OPENSIGN_WEBHOOK_SECRET=your-opensign-webhook-secret
```

For Docker self-host mode, replace the token settings with:

```bash
OPENSIGN_API_MODE=selfhost
OPENSIGN_PARSE_BASE_URL=http://127.0.0.1:3051/api/app
OPENSIGN_PUBLIC_URL=https://your-opensign-host
OPENSIGN_PARSE_HOST_HEADER=your-opensign-host
OPENSIGN_PARSE_APP_ID=opensign
OPENSIGN_PARSE_MASTER_KEY=your-self-hosted-parse-master-key
OPENSIGN_ADMIN_EMAIL=admin@example.com
OPENSIGN_ADMIN_PASSWORD=your-local-opensign-admin-password
OPENSIGN_WEBHOOK_SECRET=your-opensign-webhook-secret
OPENSIGN_SELFHOST_SEND_EMAIL=true
OPENSIGN_SELFHOST_REQUIRE_EMAIL=false
```

Configure the OpenSign webhook target to Mike:

```bash
${MIKE_PUBLIC_API_BASE_URL}/webhooks/signing/opensign
```

Use the same webhook secret in OpenSign and `OPENSIGN_WEBHOOK_SECRET`.
When `PUBLIC_WEBHOOK_REQUIRED=true` or `NODE_ENV=production`, Mike rejects
unsigned OpenSign webhooks if `OPENSIGN_WEBHOOK_SECRET` is missing.

For Docker self-hosted OpenSign email delivery with Gmail, configure
OpenSign's own `.env.prod` with:

```bash
SMTP_ENABLE=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER_EMAIL=admin@example.com
SMTP_USERNAME=admin@example.com
SMTP_PASS=your-google-app-password
```

Then recreate or restart the OpenSign server container. `SMTP_PASS` must be a
Google app password, not the normal Google account password.

This repo also includes a helper that prompts for the app password and updates
OpenSign's `.env.prod` without echoing the secret:

```powershell
.\scripts\configure-opensign-gmail.ps1 -Restart
```

Restart the backend and check:

```bash
curl http://localhost:3001/health/integrations
```

Green means `opensign.configured`, `opensign.webhookSecretRequired`,
`opensign.webhookSecretConfigured`, `opensign.webhookTargetPublic`,
`opensign.webhookReadyForPublic`, and `opensign.readyForPublicSigning` are all
true. The first live signature request is still the real API validation gate.

The doctor prints the exact derived webhook target under `Public webhook routing`.

## 11a. Local Storage Choice

Mike requires an S3-compatible storage target for generated documents and
signed-PDF imports. Use Supabase local storage for this Windows workspace and
Cloudflare R2 or another managed S3-compatible service for production.

This local Windows setup can use Supabase's S3-compatible storage endpoint:

```bash
SUPABASE_URL=http://127.0.0.1:54321
R2_ENDPOINT_URL=http://127.0.0.1:54321/storage/v1/s3
R2_BUCKET_NAME=mike
```

Before running `integration:persisted-smoke` or the positive loop, confirm
`R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and
`R2_BUCKET_NAME` point at the active storage target.

## 12. End-to-end app loop

1. Start backend and frontend.
2. Sign in.
3. Select `Ollama Local Legal` in the model picker.
4. Ask Mike to draft a simple test agreement.
5. Confirm a generated `.docx` appears as a document card.
6. Open the generated document and send it for signature to a test recipient.
7. Confirm a signature request row appears with recipient status and signing link.
8. In a local terminal, watch the Mike request:

```bash
npm run integration:signature-watch --prefix backend -- --document-id <document-id> --watch --sync
```

PowerShell env-var form:

```powershell
$env:SIGNATURE_DOCUMENT_ID='<document-id>'
$env:SIGNATURE_WATCH='true'
$env:SIGNATURE_SYNC_PROVIDER='true'
npm run integration:signature-watch --prefix backend
```

9. Complete the signing flow in OpenSign.
10. Confirm the webhook updates the request to `completed` and signed-PDF import becomes available.
11. Download the signed PDF from Mike.

If a gate fails, keep the prior green gate as the rollback point and inspect only the next boundary: model health, document generation, OpenSign create response, webhook payload matching, or signed-PDF import.

If `127.0.0.1:3000` does not load, verify the frontend process first:

```powershell
npm run dev --prefix frontend
Invoke-WebRequest http://127.0.0.1:3000 -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:3001/health -UseBasicParsing
```

Port `3000` is only the Next.js frontend. The backend health endpoint is on
`3001` by default. If PowerShell gets a `200` from `127.0.0.1:3000` but a
browser-control plugin cannot load it, the local app is reachable and the issue
is the browser/plugin session rather than Mike.

## Architecture Note

There is no standalone legacy runtime module in this repo today. The legal assistant behavior lives in the Mike backend LLM and document-tool layer, while the wider AutoYou runtime already has its own Ollama provider wiring and admin status API. For now, integrate Mike with that runtime by sharing the same local Ollama service and env contract: `AI_PROVIDER=ollama`, `OLLAMA_API_BASE`, and `OLLAMA_MODEL`. Use `AUTOYOU_ADMIN_API_BASE` to prove the broader runtime is reachable during live testing.

OpenSign should stay a separate HTTP signing service. That keeps the future split simple: Mike generates and tracks legal documents, OpenSign owns sender email, signing links, and signed-PDF completion, and a future AutoYou service can be added at the model/tool boundary if it needs a separate GPU host or security boundary.
