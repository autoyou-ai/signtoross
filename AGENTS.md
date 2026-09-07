# SignToROSS Agent Instructions

This repository is standalone. Do not rely on private AutoYou runtime source.

## Layout

- `apps/mike` - MikeOSS-derived app with OpenSign/Ollama/SignToROSS integration.
- `services/opensign` - OpenSign Docker deployment template for self-hosted signing.
- `scripts` - root orchestration and verification helpers.
- `tools/tunnel-agent` - dependency-free Cloudflare Tunnel CLI, with Claude and OpenAI manifests.

## Safety

- Never commit real `.env`, `.env.local`, `.env.prod`, app-password, SMTP-password, Parse master key, Supabase service-role key, DNS-provider token, OpenSign admin password, or machine-local credential file.
- Do not expose local Windows profile paths or machine-specific private paths.
- The only AutoYou-specific surface that may remain is the optional HTTP API integration layer in `apps/mike/backend/src/lib/autoyouRuntime.ts` and its tests/smokes.
- Do not add legacy compatibility for removed signing paths or removed runtime environment variables.
- Do not add nested `.git` directories. Initialize Git only at this root when ready.

## Licence

The whole repository is AGPL-3.0. `apps/mike` derives from MikeOSS and carries the
same licence upstream. Do not add a file claiming different terms, and do not
relicense any part of the tree.

If you change this software and run it on a public hostname, AGPL section 13
obliges you to offer users the source of your modified version.

## Before Git Init Or Commit

Run:

```powershell
.\scripts\verify-public-tree.ps1
.\scripts\verify-signtoross.ps1 -SkipBuild
```

Then initialize Git at this repository root only:

```powershell
git init
git add .
git status --short
```

Check that no ignored env files are staged before committing.
