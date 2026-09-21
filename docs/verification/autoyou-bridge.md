# AutoYou bridge verification

The live check passed on 21 September 2026 UTC using the running Mike backend,
AutoYou Server 8.0.8.0, and local Ollama with `qwen3.8:27b`.
The [recorded result](autoyou-bridge.json) contains the synthetic request marker,
returned text, session, responding agent, and individual checks.

Mike reached the real AutoYou admin and chat APIs. AutoYou's worker log recorded
the Ollama completion for this request. The reply preserved the fresh marker
and session. With the bridge pointed at an unavailable endpoint, the same
adapter returned a failure and no fallback reply. Cloud fallback was disabled.

This verifies the optional HTTP readiness/advice bridge. Mike's document
drafting uses its separate Ollama adapter; this check does not exercise DOCX/PDF
generation, public hosting, or an OpenSign signing transaction.

## What the check requires

- A running Mike backend with network access to AutoYou's admin and chat APIs.
- AutoYou configured to use a running local Ollama service and an installed model.
- Matching Mike Ollama settings, `OLLAMA_CLOUD_FALLBACK=false`, and enough time
  for local model loading. The recorded run allowed 180 seconds for the reply.

These services can communicate on a private Docker network. Mike can remain at
`http://127.0.0.1:3052/login`; no public Mike hostname, DNS record, OpenSign
account, signature request, or recipient email is needed for this check.

## Recorded acceptance checks

| Check | Evidence required |
| --- | --- |
| Admin reachable | The real AutoYou admin API responds. |
| Provider aligned | AutoYou reports Ollama and Mike's provider settings pass the alignment check. |
| Fresh chat reply | The real response contains this run's unique marker and the requested OpenSign text. |
| Session preserved | The response returns the requested session ID and identifies its agent. |
| Unavailable bridge rejected | An unreachable AutoYou endpoint produces failure and no fallback text. |
| Cloud fallback disabled | Mike's cloud-fallback setting is explicitly false. |

All six checks passed in the recorded run. No further work is pending for this
bridge verification. Routing Mike's document-generation tools through AutoYou
would be a separate implementation change; this result does not claim that
behavior or verify multi-turn conversation memory.

Use the [Docker bridge setup and live command](../../services/mike/README.md#ollama-and-opensign)
to repeat the check. It creates a synthetic AutoYou conversation and sends no
signature request or recipient email.
