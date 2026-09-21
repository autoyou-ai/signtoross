# Contributing to SignToROSS

Contributions to setup instructions, accessibility, document tools, signing
adapters, tests, and deployment diagnostics are welcome. Report a reproducible
bug or propose a larger change in [GitHub issues](https://github.com/autoyou-ai/signtoross/issues).
Include expected behavior, actual behavior, and the relevant component/version.

## Development

1. Fork and clone the repository. Create a branch for one focused change.
2. Follow [Mike setup](apps/mike/README.md) if your change needs its frontend or backend.
3. Use synthetic documents and recipients. Do not send a signature request to a
   real person while running a test unless that person and the operator agreed.
4. Run the checks below and explain the results in your pull request.

```powershell
.\scripts\verify-public-tree.ps1
.\scripts\verify-signtoross.ps1 -SkipBuild
```

For Mike code changes:

```bash
npm ci --prefix apps/mike/backend
npm ci --prefix apps/mike/frontend
npm run build --prefix apps/mike/backend
npm run build --prefix apps/mike/frontend
npm run smoke:adapters --prefix apps/mike/backend
npm run integration:autoyou-signtoross-smoke --prefix apps/mike/backend
```

The frontend build needs the public Supabase/API variables documented in
[Mike setup](apps/mike/README.md). The adapter and AutoYou bridge smokes use
mock services. For a configured deployment, `integration:live-preflight` checks
live dependencies without sending signature emails. See the
[integration guide](apps/mike/docs/opensign-ollama-live-loop.md).

## Pull requests

Describe the problem, the resulting behavior, and the checks you ran. For a UI
change, include a real capture with synthetic data. Note any schema migration,
environment variable, or upgrade step. Keep unrelated cleanup in a separate PR.

Never commit real environment files, passwords, tokens, private keys, database
dumps, customer documents, or local machine paths. Inspect `git diff --cached`
before committing. Report a suspected vulnerability privately through GitHub's
private vulnerability reporting when available; do not post exploit details or
credentials in a public issue.

Preserve [AGPL-3.0](LICENSE), upstream notices, and [NOTICE](NOTICE).
