# Host Mike with Docker

This Compose project runs Mike's frontend and API, Supabase Auth/Postgres,
PostgREST, file-backed S3-compatible storage, and Caddy. LibreOffice in the API
image renders generated DOCX files as PDFs. It uses a separate network and
persistent volumes; it can connect to an existing OpenSign deployment.

The Supabase image versions follow the official
[self-hosted v0.8.1 configuration](https://github.com/supabase/supabase/blob/self-hosted/v0.8.1/docker/docker-compose.yml).
This is a Compose deployment, not the Supabase CLI development stack.

## Configure and start

Requirements: Docker Desktop or Docker Engine with Compose v2, Python 3.10+,
and a running Ollama instance with the selected model installed.

From this directory:

```sh
python configure.py --public-url https://mike.example.com --ollama-model YOUR_INSTALLED_MODEL
docker compose build
docker compose up -d --wait
python create-user.py --email owner@example.com --name Owner
```

`configure.py` creates unique secrets in ignored `.env` and `.env.backend`
files. It refuses to overwrite an existing installation. Account passwords are
generated and saved under ignored `.local/`; they are never printed. The account
command does not send mail and does not reset an existing user's password.

The gateway binds to `127.0.0.1:3052`. Database, authentication administration,
PostgREST, model, and diagnostic ports are not published. Public requests need a
Mike login to access application data. Public signup is disabled; create each
approved account with `create-user.py`. There is no public password-reset flow
in this deployment. Do not enable signup without configuring and testing email
verification, recovery, and abuse controls.

For a local-only installation, use `--public-url http://localhost:3052`.
The public URL is embedded in the frontend build. Rebuild the frontend after
changing it, then recreate services with `docker compose up -d --wait`.

## Connect the public hostname

Publish the chosen hostname through your existing tunnel to
`http://127.0.0.1:3052`. The tunnel connector must run on the same host. Keep a
single connector unless every replica can reach the same origins. Do not expose
the database or internal gateway listener. The browser-facing origin must use
HTTPS. Keep the computer awake and Docker Desktop and the connector running.

`docker compose ps` should report seven healthy services and a successfully
completed `db-init` job. All long-running services use `restart: unless-stopped`.
The initial schema is applied once in a transaction. Existing installations
retain their database and documents when rebuilt or restarted.

The login page and `/source` link provide the corresponding SignToROSS source.
When deploying a fork, update those links to the version you actually serve.

## Ollama and OpenSign

The generated `.env.backend` uses `host.docker.internal:11434`, your selected
model, a 32K context, a 4096-token output limit, and no cloud fallback.
The model must support tool calls. Verify actual document generation rather
than relying only on a successful health response. `OLLAMA_CHAT_TIMEOUT_MS`
sets the complete streamed request deadline, including the response body.
`OLLAMA_NUM_CTX`, `OLLAMA_NUM_PREDICT`, and `OLLAMA_TEMPERATURE` are per-request
settings, so they do not change the host's global Ollama configuration.

For an existing self-hosted OpenSign instance, add these to `.env.backend`:

```env
OPENSIGN_API_MODE=selfhost
OPENSIGN_PARSE_BASE_URL=http://host.docker.internal:3051/api/app
OPENSIGN_PUBLIC_URL=https://sign.example.com
OPENSIGN_PARSE_HOST_HEADER=sign.example.com
OPENSIGN_PARSE_APP_ID=opensign
OPENSIGN_PARSE_MASTER_KEY=your-existing-master-key
OPENSIGN_ADMIN_EMAIL=your-existing-admin-email
OPENSIGN_ADMIN_PASSWORD=your-existing-admin-password
OPENSIGN_WEBHOOK_SECRET=your-configured-shared-webhook-secret
OPENSIGN_SELFHOST_SEND_EMAIL=false
OPENSIGN_SELFHOST_REQUIRE_EMAIL=false
```

Recreate the backend after editing its env file. Configure the matching OpenSign
callback as `https://mike.example.com/backend/webhooks/signing/opensign` before
using webhook delivery. Email sending stays disabled until the operator enables
it deliberately. Generating a document does not send a signing request.

The optional AutoYou readiness/advice bridge is independent of Mike's direct
Ollama drafting route. Configure it only when those HTTP services are available.

To require and verify that bridge, set the following in `.env.backend`, using
addresses reachable from the backend container. The example assumes an AutoYou
service named `autoyou` on a shared private Docker network:

```env
AUTOYOU_ADMIN_API_BASE=http://autoyou:8001
AUTOYOU_CHAT_API_BASE=http://autoyou:8081
AUTOYOU_RUNTIME_REQUIRED=true
AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED=true
AUTOYOU_RUNTIME_TIMEOUT_MS=5000
AUTOYOU_SIGNTOROSS_ADVICE_TIMEOUT_MS=180000
```

Recreate the backend after changing these settings, then run:

```sh
docker compose exec -T backend node dist/scripts/autoyouBridgeLive.js --json
```

This live check requires `OLLAMA_CLOUD_FALLBACK=false`. It checks the admin
provider, requests a fresh text fixture through AutoYou, verifies the returned
session and agent, and confirms that an unavailable AutoYou endpoint fails
without a fallback reply. Allow for local model loading time. The check creates
a test conversation in AutoYou and sends no signature request. Outside Docker,
run `npm run integration:autoyou-bridge-live --prefix apps/mike/backend -- --json`
from the repository root with the same environment configured.
See the [recorded live verification](../../docs/verification/autoyou-bridge.md)
for the checked behavior and its scope.

## Verify, update, and back up

```sh
docker compose exec -T backend node dist/scripts/smokeAdapters.js
docker compose exec -T backend node dist/scripts/ollamaStreamConfigSmoke.js
docker compose exec -T backend node dist/scripts/publicWebhookRejectionSmoke.js
docker compose exec -T backend node dist/scripts/integrationDoctor.js
```

The doctor includes real storage and model requests. Its public-webhook check
validates configuration, not delivery from OpenSign. The optional AutoYou checks
can warn when those services are absent. Inspect each result rather than treating
a configured URL as proof of an end-to-end signing transaction.

Before updates, preserve the env files and back up Postgres with `pg_dump` plus
the `documents` volume. Keep both backups together so stored document paths and
objects agree. Stop API writes while taking a consistent backup, and test restore
to a separate Compose project before relying on it. Do not use `down -v` for
routine updates; that deletes persistent data. Apply future schema migrations
explicitly rather than rerunning the initial schema over an existing database.
