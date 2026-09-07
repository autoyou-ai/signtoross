# SignToROSS tunnel agent

Publishes a self-hosted SignToROSS signing stack on a public hostname through a
Cloudflare Tunnel, and refuses to do so when the configuration is in a state
known to fail intermittently.

Standard-library Python 3.10+. No dependencies, no install step — you can copy
the single file onto a machine and diagnose a deployment with it.

## Commands

| Command | Does | Safe to re-run |
|---|---|---|
| `preflight` | cloudflared present, token file readable, origin answering, route on loopback | yes, read-only |
| `up` | starts exactly one connector | yes, no-ops if one is running |
| `status` | connector count, service/container connectors, origin and public hostname | yes, read-only |
| `doctor` | samples the hostname to expose split-brain routing | yes, read-only |
| `down` | stops this deployment's connector | yes |

```bash
python signtoross_tunnel.py preflight --root /path/to/deployment
python signtoross_tunnel.py up      --hostname sign.example.com
python signtoross_tunnel.py status  --hostname sign.example.com --json
python signtoross_tunnel.py doctor  --hostname sign.example.com --samples 10
python signtoross_tunnel.py down
```

Exit codes: `0` healthy, `1` an actionable problem, `2` misuse. Flags work
before or after the subcommand.

## Configuration

| Flag | Environment variable | Default |
|---|---|---|
| `--root` | — | current directory |
| `--token-file` | — | `<root>/.local/cloudflared-token.txt` |
| `--origin` | `SIGNTOROSS_ORIGIN` | `http://127.0.0.1:3051` |
| `--hostname` | `SIGNTOROSS_PUBLIC_HOSTNAME` | none; public probes are skipped |

The tunnel token is read from a file and passed to cloudflared as
`--token-file`. It is never accepted as an argument, never logged, and never
included in JSON output — arguments are visible to every process on the machine.

## The failure this catches

A Cloudflare Tunnel's routes belong to the tunnel, not to any connector. Every
connector holding the token receives all of them, and Cloudflare balances across
them. That is fine until two connectors resolve the origin differently:
`127.0.0.1` inside a container is the container, not the host.

The result is a hostname that answers 200 to some requests and 502 to others,
with nothing in any single request to explain it. The usual instinct — restart
the tunnel — starts a third connector and makes it worse.

`status` counts connectors, including a Windows service or a container that you
may have forgotten. `doctor` sends several requests and reports the mixed-code
signature directly:

```
  [FAIL] uniform responses: 10 requests -> 6 served, 4 502 (codes: 200, 502)
         -> This is the signature of more than one connector on the tunnel.
            Routes belong to the tunnel, so every connector with its token
            receives them; the one that cannot reach the origin returns 502.
            Stop all but the connector on this host, then re-run.
```

The fix is always to reduce to one connector on the host that owns the origin —
never to restart.

`preflight` also fails a non-loopback origin on purpose. A LAN address lets a
connector on another machine answer the route, which is how the split starts.

## Driving it from an agent

`manifests/claude-skill/SKILL.md` is a Claude skill. `manifests/openai-tools.json`
is an OpenAI function-calling schema covering the same five commands. Both
carry the operational rules: confirm with the operator before `up`, because it
exposes a signing service publicly, and never restart to fix a mixed 200/502
result.

Use `--json` for structured output. Each check is `{name, ok, detail, remedy}`;
when `ok` is false, `remedy` says what to do.
