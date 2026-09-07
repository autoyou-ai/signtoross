# SignToROSS

SignToROSS packages **AutoYou powered OpenSign + MikeOSS** as a standalone
starter for legal document drafting, local Ollama-assisted review, and
OpenSign signature workflows, connected to public endpoints through secure
Cloudflare tunnels to your personal system behind private home networks.

This public tree contains reusable application code, Docker templates, and
verification scripts. It does not contain live deployment files, provider DNS
configuration, production hosts, credentials, or private AutoYou runtime code.

## What Is Included

```text
apps/mike/          MikeOSS-derived web app and Express backend
services/opensign/  OpenSign Docker Compose template
docs/               Sanitized project notes and runbooks
scripts/            Install, startup, and verification helpers
```

The Mike backend can optionally probe an AutoYou-compatible runtime over HTTP
using `AUTOYOU_ADMIN_API_BASE` and `AUTOYOU_CHAT_API_BASE`. That bridge is
configuration-only; no private runtime repository is included or required.

## Requirements

- Node.js 20 or newer
- npm
- Docker Desktop, for the self-hosted OpenSign template
- Supabase Auth/Postgres
- S3-compatible object storage, such as Supabase local storage or R2-compatible storage
- Ollama, if you want local legal-model generation
- An OpenSign token API account or the included self-hosted OpenSign template
- LibreOffice, if you need DOC/DOCX to PDF conversion

## Install

Install backend and frontend dependencies:

```powershell
.\scripts\install-mike.ps1
```

Create local environment files from the public examples:

```powershell
Copy-Item apps\mike\backend\.env.example apps\mike\backend\.env
Copy-Item apps\mike\frontend\.env.local.example apps\mike\frontend\.env.local
Copy-Item services\opensign\.env.prod.example services\opensign\.env.prod
```

Fill those local files with your own Supabase, storage, model-provider,
OpenSign, and webhook values. The real `.env` files are ignored and must not be
committed.

For local Ollama use, pull the model named by `OLLAMA_MODEL`, then set either
`AI_PROVIDER=ollama` or `OLLAMA_ENABLED=true` in `apps\mike\backend\.env`.

## Run

Start the Mike backend and frontend in separate terminals:

```powershell
npm run dev --prefix apps\mike\backend
npm run dev --prefix apps\mike\frontend
```

Open the app at `http://localhost:3000`.

To run the bundled OpenSign template:

```powershell
.\scripts\start-opensign.ps1
```

### Publishing the signing hostname

`tools/tunnel-agent/` brings the stack onto a public hostname through a
Cloudflare Tunnel. It is dependency-free Python and works on Windows, macOS and
Linux:

```bash
python tools/tunnel-agent/signtoross_tunnel.py preflight
python tools/tunnel-agent/signtoross_tunnel.py up --hostname sign.example.com
python tools/tunnel-agent/signtoross_tunnel.py status --hostname sign.example.com
python tools/tunnel-agent/signtoross_tunnel.py down
```

Expose the hostname only while you are actively sending signature requests, and
close it afterwards.

If the hostname starts answering some requests and 502-ing others, run
`doctor` rather than restarting — restarting adds a connector and makes it
worse:

```bash
python tools/tunnel-agent/signtoross_tunnel.py doctor --hostname sign.example.com
```

Audit what the hostname exposes, from outside:

```bash
python tools/tunnel-agent/signtoross_tunnel.py harden --hostname sign.example.com
```

`harden` checks that traffic arrives through Cloudflare, that HSTS,
`X-Content-Type-Options` and `Referrer-Policy` are set, that the signing page
cannot be framed, and that `/health` and `/api/app` are not publicly reachable.
The bundled `services/opensign/Caddyfile` sets all of these; if `harden`
reports them missing, the edge is running an older config.

The agent ships a Claude skill and an OpenAI function schema under
`tools/tunnel-agent/manifests/`, so an assistant can run and diagnose the tunnel
directly. See [`tools/tunnel-agent/README.md`](tools/tunnel-agent/README.md).

The Windows PowerShell equivalents remain available as
`scripts\start-public-tunnel.ps1` and `scripts\stop-public-tunnel.ps1`.

The public OpenSign route intentionally does not expose Mike health endpoints.
Check Mike health locally at `http://127.0.0.1:3001/health` and
`http://127.0.0.1:3001/health/integrations`.

The OpenSign callback path for Mike is:

```text
<MIKE_PUBLIC_API_BASE_URL>/webhooks/signing/opensign
```

## Configure OpenSign

Token API mode:

```env
SIGNING_PROVIDER=opensign
OPENSIGN_API_MODE=token
OPENSIGN_API_BASE_URL=https://sign.example.com/api/v1.2
OPENSIGN_API_TOKEN=your-opensign-x-api-token
OPENSIGN_WEBHOOK_SECRET=your-opensign-webhook-secret
```

Self-hosted mode:

```env
SIGNING_PROVIDER=opensign
OPENSIGN_API_MODE=selfhost
OPENSIGN_PARSE_BASE_URL=http://127.0.0.1:3051/api/app
OPENSIGN_PUBLIC_URL=https://sign.example.com
OPENSIGN_PARSE_HOST_HEADER=sign.example.com
OPENSIGN_PARSE_APP_ID=opensign
OPENSIGN_PARSE_MASTER_KEY=your-self-hosted-parse-master-key
OPENSIGN_ADMIN_EMAIL=admin@example.com
OPENSIGN_ADMIN_PASSWORD=your-local-opensign-admin-password
OPENSIGN_WEBHOOK_SECRET=your-opensign-webhook-secret
```

For public webhook mode, set `PUBLIC_WEBHOOK_REQUIRED=true` and configure your
OpenSign instance to call the Mike callback URL above with the same webhook
secret.

## Verify

Fast public-tree and secret-shape check:

```powershell
.\scripts\verify-public-tree.ps1
```

Build and Docker Compose validation:

```powershell
.\scripts\verify-signtoross.ps1
```

Fast validation without rebuilding:

```powershell
.\scripts\verify-signtoross.ps1 -SkipBuild
```

Optional live checks use only your own configured endpoints:

```powershell
$env:SIGNTOROSS_LIVE_OPENSIGN_HEALTH_URL = "https://sign.example.com/health"
.\scripts\verify-signtoross.ps1 -Live -SkipBuild
```

More integration checks are documented in `apps\mike\README.md`.

## Safety

Do not commit real `.env`, `.env.local`, `.env.prod`, app passwords, SMTP
passwords, Parse master keys, Supabase service-role keys, OpenSign admin
passwords, DNS-provider tokens, or machine-local credential files. The root
`.gitignore` excludes common runtime and credential files, and
`scripts\verify-public-tree.ps1` blocks known private deployment references.

## License

SignToROSS is licensed under the **GNU Affero General Public License v3.0**.
See [`LICENSE`](LICENSE) for the full text and [`NOTICE`](NOTICE) for
third-party attribution.

`apps/mike` derives from [Mike](https://mikeoss.com), which is AGPL-3.0-only;
the whole repository carries the same licence so that no part of it is
ambiguous. `services/opensign` is a deployment template that pulls the
published OpenSign and Caddy images at run time and vendors neither.

### If you deploy this publicly, section 13 applies to you

AGPL-3.0 section 13 covers network use. If you run a modified version of this
software and let users interact with it over a network — which is exactly what
the tunnel tooling here is for — you must offer those users the source of your
modified version. Keep a link to your source reachable from the running
service. Publishing your fork satisfies this; running a private modification on
a public hostname does not.
