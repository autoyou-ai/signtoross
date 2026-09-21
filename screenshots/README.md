# Live application captures

This directory contains screenshots captured directly from the running
applications. Keep it limited to Mike document drafting and OpenSign signing.

| File | Source | What is visible |
| --- | --- | --- |
| [opensign-hosted-dashboard.png](opensign-hosted-dashboard.png) | https://sign.autoyou.me/ | Signed-in OpenSign 2.38.0 dashboard with empty document lists |

The dashboard was captured on 21 September 2026 UTC. It verifies that the hosted
OpenSign interface renders. It does not establish a completed signature or prove
that a Mike response passed through AutoYou or Ollama.

[captures.json](captures.json) records provenance and SHA-256 checksums. Captures
are unmodified browser screenshots. Use synthetic document content for further
captures and inspect every frame for credentials, document details, recipients,
and private account information before committing it.
