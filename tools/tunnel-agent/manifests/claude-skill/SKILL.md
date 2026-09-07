---
name: signtoross-tunnel
description: Publish, verify, or repair the Cloudflare Tunnel that puts a self-hosted SignToROSS signing stack on a public hostname. Use when the signing hostname is unreachable, returns intermittent 502s, needs to be brought up before sending signature requests, or needs to be taken down afterwards. Also use to check tunnel health before any operation that depends on the public callback URL.
---

# SignToROSS tunnel

Drive `tools/tunnel-agent/signtoross_tunnel.py`. It is standard-library Python
with no install step, and every command is idempotent.

Pass `--json` for machine-readable output. Exit codes carry the verdict:
`0` healthy, `1` an actionable problem, `2` misuse. Every failing check
includes a `remedy` field — read it before deciding what to do next.

## Choosing a command

| Situation | Command |
|---|---|
| About to send signature requests | `preflight`, then `up` |
| Is the public hostname serving? | `status` |
| Intermittent 502s, or "works sometimes" | `doctor` |
| Signing window finished | `down` |

```bash
python tools/tunnel-agent/signtoross_tunnel.py status --json \
  --root /path/to/deployment --hostname sign.example.com
```

`--root` is the deployment directory holding `.local/cloudflared-token.txt`.
`--hostname` may instead come from `SIGNTOROSS_PUBLIC_HOSTNAME`, and the local
origin from `SIGNTOROSS_ORIGIN` (default `http://127.0.0.1:3051`).

## The failure this tool exists to catch

A Cloudflare Tunnel's routes belong to the tunnel, not to a connector. Every
connector holding the token receives all of them, and Cloudflare balances
across connectors. Two connectors resolve `127.0.0.1` to two different
machines, so one serves the origin and the other cannot reach it.

The result is a hostname that returns 200 to some requests and 502 to others,
with no pattern visible in any single request. `status` counts connectors;
`doctor` samples the hostname repeatedly and reports the mixed-code signature
directly.

**When `doctor` reports a mix of 200 and 502, do not restart the tunnel.**
Restarting starts another connector and makes it worse. Find the extra
connector — a Windows service, a container, a second shell — and stop it, so
exactly one remains on the host that owns the origin. Then re-run `doctor`.

## Rules

- Never pass a tunnel token as a command argument, and never echo one. Arguments
  are visible to every process on the machine. The tool reads the token from a
  file for this reason and never prints it.
- Do not run `up --force` to get past a "competing connector" failure. That flag
  exists for the case where you have already confirmed the other connector does
  not hold this tunnel's token; using it to silence the check reintroduces the
  split-brain failure above.
- Bringing the tunnel up exposes a signing service to the public internet. Treat
  `up` as an action needing the operator's agreement, and `down` as the thing to
  do when the signing window closes.
- The Cloudflare route must point at a loopback address. `preflight` fails a
  non-loopback origin on purpose: a LAN address lets a connector on another
  machine answer.
