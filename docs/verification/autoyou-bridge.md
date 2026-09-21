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

Use the [Docker bridge setup and live command](../../services/mike/README.md#ollama-and-opensign)
to repeat the check. It creates a synthetic AutoYou conversation and sends no
signature request or recipient email.
