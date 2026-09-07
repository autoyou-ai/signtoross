#!/usr/bin/env python3
"""SignToROSS Cloudflare Tunnel agent.

Brings a self-hosted OpenSign deployment onto a public hostname through a
Cloudflare Tunnel, and refuses to do so when the configuration is in a state
that is known to fail intermittently.

Why this exists as a program rather than a runbook
--------------------------------------------------
A Cloudflare Tunnel is defined by its routes, and every connector holding the
tunnel's token receives all of them. Start a second connector -- a container
alongside a host service, say -- and Cloudflare load-balances between them.
Each then resolves the same origin address differently: 127.0.0.1 inside a
container is the container, not the host. Requests that land on the wrong
connector return 502 while the rest return 200, so the deployment looks
"mostly up" and the cause is invisible from any single request.

That failure is silent, intermittent, and costs hours to find. `status` counts
connectors and `doctor` samples the public hostname repeatedly to detect the
mixed 200/502 signature, so the tool finds it in seconds instead.

Design constraints
------------------
* Standard library only. No install step before you can diagnose a deployment.
* Every command is idempotent and safe to re-run.
* `--json` on any command emits a machine-readable object for agent use, and
  the exit code carries the verdict: 0 healthy, 1 actionable problem,
  2 misuse.
* The tunnel token is read from a file, never accepted as an argument, never
  logged, and never included in JSON output. Tokens in argv are visible to
  every process on the machine.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

AGENT_VERSION = "1.0.0"

# Where the OpenSign edge listens on the host. The Cloudflare route must point
# at this address, on loopback, so that only a connector running on this host
# can serve it.
DEFAULT_ORIGIN = "http://127.0.0.1:3051"
DEFAULT_TOKEN_FILE = Path(".local") / "cloudflared-token.txt"
DEFAULT_LOG_DIR = Path(".local")

IS_WINDOWS = platform.system() == "Windows"
CLOUDFLARED_PROC = "cloudflared.exe" if IS_WINDOWS else "cloudflared"


# --------------------------------------------------------------------------- #
#  Result plumbing
# --------------------------------------------------------------------------- #

@dataclass
class Check:
    """One named condition, with the remedy attached to the failure."""
    name: str
    ok: bool
    detail: str
    remedy: str = ""

    def line(self) -> str:
        mark = "PASS" if self.ok else "FAIL"
        out = f"  [{mark}] {self.name}: {self.detail}"
        if not self.ok and self.remedy:
            out += f"\n         -> {self.remedy}"
        return out


@dataclass
class Result:
    command: str
    ok: bool = True
    checks: list[Check] = field(default_factory=list)
    data: dict[str, Any] = field(default_factory=dict)
    messages: list[str] = field(default_factory=list)

    def add(self, check: Check) -> Check:
        self.checks.append(check)
        if not check.ok:
            self.ok = False
        return check

    def say(self, message: str) -> None:
        self.messages.append(message)

    def emit(self, as_json: bool) -> int:
        if as_json:
            payload = asdict(self)
            payload["agent_version"] = AGENT_VERSION
            print(json.dumps(payload, indent=2))
        else:
            print(f"\nsigntoross-tunnel {self.command}")
            for check in self.checks:
                print(check.line())
            for message in self.messages:
                print(f"  {message}")
            print(f"\n  => {'OK' if self.ok else 'ATTENTION REQUIRED'}\n")
        return 0 if self.ok else 1


# --------------------------------------------------------------------------- #
#  Process inspection
# --------------------------------------------------------------------------- #

def _run(cmd: list[str], timeout: int = 20) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout)
        return proc.returncode, proc.stdout, proc.stderr
    except FileNotFoundError:
        return 127, "", f"not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s: {' '.join(cmd[:2])}"


def cloudflared_processes() -> list[dict[str, Any]]:
    """Every running cloudflared process, with its command line.

    The command line matters: it is how a connector started by this tool is
    told apart from one started by a Windows service or a container, which is
    the distinction the single-connector rule turns on.
    """
    if IS_WINDOWS:
        code, out, _ = _run([
            "powershell", "-NoProfile", "-NonInteractive", "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | "
            "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ])
        if code != 0 or not out.strip():
            return []
        try:
            parsed = json.loads(out)
        except json.JSONDecodeError:
            return []
        rows = parsed if isinstance(parsed, list) else [parsed]
        return [{"pid": r.get("ProcessId"),
                 "cmdline": r.get("CommandLine") or ""}
                for r in rows if r.get("ProcessId")]

    code, out, _ = _run(["ps", "-eo", "pid=,args="])
    if code != 0:
        return []
    found = []
    for line in out.splitlines():
        line = line.strip()
        if not line or "cloudflared" not in line:
            continue
        pid, _, args = line.partition(" ")
        if "signtoross_tunnel" in args:      # never match this program itself
            continue
        try:
            found.append({"pid": int(pid), "cmdline": args.strip()})
        except ValueError:
            continue
    return found


def windows_service_state() -> str | None:
    """State of a `Cloudflared` Windows service, if one is installed.

    A service connector is the most common second connector, because it
    survives reboots and is easy to forget.
    """
    if not IS_WINDOWS:
        return None
    code, out, _ = _run([
        "powershell", "-NoProfile", "-NonInteractive", "-Command",
        "(Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue).Status",
    ])
    state = out.strip()
    return state or None


def docker_connectors() -> list[str]:
    """Containers that look like cloudflared connectors."""
    if not shutil.which("docker"):
        return []
    code, out, _ = _run(["docker", "ps", "--format", "{{.Names}}\t{{.Image}}"])
    if code != 0:
        return []
    hits = []
    for line in out.splitlines():
        name, _, image = line.partition("\t")
        if "cloudflare" in image.lower() or "cloudflared" in name.lower():
            hits.append(name.strip())
    return hits


# --------------------------------------------------------------------------- #
#  HTTP probes
# --------------------------------------------------------------------------- #

def probe(url: str, timeout: int = 10) -> tuple[int | None, str]:
    req = urllib.request.Request(url, method="GET",
                                 headers={"User-Agent": "signtoross-tunnel"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, ""
    except urllib.error.HTTPError as exc:
        return exc.code, ""
    except urllib.error.URLError as exc:
        return None, str(exc.reason)
    except Exception as exc:                       # noqa: BLE001
        return None, str(exc)


# --------------------------------------------------------------------------- #
#  Shared context
# --------------------------------------------------------------------------- #

@dataclass
class Ctx:
    root: Path
    token_file: Path
    origin: str
    hostname: str | None

    @classmethod
    def build(cls, args: argparse.Namespace) -> "Ctx":
        root = Path(args.root).resolve() if args.root else Path.cwd()
        token = Path(args.token_file) if args.token_file else root / DEFAULT_TOKEN_FILE
        return cls(
            root=root,
            token_file=token if token.is_absolute() else (root / token),
            origin=args.origin or os.environ.get("SIGNTOROSS_ORIGIN", DEFAULT_ORIGIN),
            hostname=args.hostname or os.environ.get("SIGNTOROSS_PUBLIC_HOSTNAME"),
        )

    def public_url(self, path: str = "/") -> str | None:
        if not self.hostname:
            return None
        host = self.hostname.replace("https://", "").replace("http://", "").rstrip("/")
        return f"https://{host}{path}"


# --------------------------------------------------------------------------- #
#  Commands
# --------------------------------------------------------------------------- #

def cmd_preflight(ctx: Ctx, args: argparse.Namespace) -> Result:
    """Everything that must be true before a tunnel can carry traffic."""
    r = Result("preflight")

    exe = shutil.which("cloudflared")
    r.add(Check("cloudflared installed", bool(exe), exe or "not on PATH",
                "Install cloudflared and put it on PATH: "
                "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"))

    if exe:
        code, out, _ = _run([exe, "--version"], timeout=15)
        version = out.strip().splitlines()[0] if out.strip() else "unknown"
        r.add(Check("cloudflared version", code == 0, version,
                    "cloudflared is present but did not report a version."))

    token_ok = ctx.token_file.is_file() and ctx.token_file.stat().st_size > 0
    r.add(Check("tunnel token file", token_ok,
                f"{ctx.token_file} ({'present' if token_ok else 'missing or empty'})",
                f"Create {ctx.token_file} containing only the tunnel token. "
                "It is gitignored. Never pass a token as a command argument."))

    status, err = probe(ctx.origin, timeout=8)
    origin_ok = status is not None and status < 500
    r.add(Check("origin reachable", origin_ok,
                f"{ctx.origin} -> {status if status else err}",
                "Start the signing stack first: docker compose -f "
                "services/opensign/docker-compose.yml up -d"))

    if not ctx.origin.startswith(("http://127.0.0.1", "http://localhost")):
        r.add(Check("origin is loopback", False, ctx.origin,
                    "Point the Cloudflare route at 127.0.0.1 so only a "
                    "connector on this host can serve it. A LAN address lets "
                    "a connector elsewhere answer, which is how split-brain "
                    "routing starts."))
    else:
        r.add(Check("origin is loopback", True, ctx.origin))

    r.data["origin"] = ctx.origin
    r.data["hostname"] = ctx.hostname
    return r


def _connector_inventory() -> dict[str, Any]:
    procs = cloudflared_processes()
    service = windows_service_state()
    containers = docker_connectors()
    total = len(procs) + len(containers)
    # A running service almost always owns one of the processes already
    # counted, so it is reported rather than added.
    return {
        "processes": procs,
        "windows_service": service,
        "docker_containers": containers,
        "process_count": len(procs),
        "container_count": len(containers),
        "total_estimated": total,
    }


def cmd_status(ctx: Ctx, args: argparse.Namespace) -> Result:
    """Who is connected, and is the public hostname actually serving."""
    r = Result("status")
    inv = _connector_inventory()
    r.data["connectors"] = inv

    count = inv["process_count"]
    if count == 0:
        r.add(Check("connector running", False, "no cloudflared process",
                    "Start one: signtoross_tunnel.py up"))
    elif count == 1:
        r.add(Check("connector running", True,
                    f"1 process (pid {inv['processes'][0]['pid']})"))
    else:
        pids = ", ".join(str(p["pid"]) for p in inv["processes"])
        r.add(Check("exactly one connector", False,
                    f"{count} cloudflared processes (pids {pids})",
                    "Stop all but one. Every connector holding this tunnel's "
                    "token receives all its routes, and Cloudflare will "
                    "balance across them. Connectors that resolve 127.0.0.1 "
                    "differently then serve some requests and 502 others."))

    if inv["docker_containers"]:
        r.add(Check("no container connector", False,
                    "containers: " + ", ".join(inv["docker_containers"]),
                    "A containerised connector resolves 127.0.0.1 to the "
                    "container, not this host, so loopback routes 502 through "
                    "it. Stop it and set --restart=no."))
    else:
        r.add(Check("no container connector", True, "none found"))

    if inv["windows_service"]:
        r.add(Check("windows service", True,
                    f"Cloudflared service is {inv['windows_service']}"))

    status, err = probe(ctx.origin, timeout=8)
    r.add(Check("origin reachable", status is not None and status < 500,
                f"{ctx.origin} -> {status if status else err}",
                "The tunnel has nothing to serve until the origin answers."))

    url = ctx.public_url()
    if url:
        status, err = probe(url, timeout=15)
        r.add(Check("public hostname", status is not None and status < 400,
                    f"{url} -> {status if status else err}",
                    "Check the route in the Cloudflare dashboard points at "
                    f"{ctx.origin}, then run: signtoross_tunnel.py doctor"))
    else:
        r.say("No public hostname configured; skipping the public probe. "
              "Pass --hostname or set SIGNTOROSS_PUBLIC_HOSTNAME to include it.")
    return r


def cmd_up(ctx: Ctx, args: argparse.Namespace) -> Result:
    """Start exactly one connector, or report why that is not safe."""
    r = Result("up")

    pre = cmd_preflight(ctx, args)
    r.checks.extend(pre.checks)
    if not pre.ok:
        r.ok = False
        r.say("Preflight failed; not starting a connector.")
        return r

    inv = _connector_inventory()
    if inv["process_count"] >= 1 and not args.force:
        pids = ", ".join(str(p["pid"]) for p in inv["processes"])
        r.add(Check("already running", True,
                    f"connector already up (pid {pids}); nothing to do"))
        r.data["pids"] = [p["pid"] for p in inv["processes"]]
        return r

    if inv["docker_containers"] and not args.force:
        r.add(Check("no competing connector", False,
                    "containers: " + ", ".join(inv["docker_containers"]),
                    "Stop the containerised connector first, or pass --force "
                    "if you have confirmed it does not hold this tunnel's "
                    "token."))
        return r

    exe = shutil.which("cloudflared")
    log_dir = ctx.root / DEFAULT_LOG_DIR
    log_dir.mkdir(parents=True, exist_ok=True)
    out_log = log_dir / "cloudflared.out.log"
    err_log = log_dir / "cloudflared.err.log"

    # --token-file keeps the token out of argv, where any local process could
    # read it from the process table.
    cmd = [exe, "tunnel", "--no-autoupdate", "run",
           "--token-file", str(ctx.token_file)]

    with open(out_log, "ab") as so, open(err_log, "ab") as se:
        kwargs: dict[str, Any] = {"stdout": so, "stderr": se}
        if IS_WINDOWS:
            kwargs["creationflags"] = 0x00000008 | 0x00000200  # detached, new group
        else:
            kwargs["start_new_session"] = True
        proc = subprocess.Popen(cmd, **kwargs)

    time.sleep(args.wait)
    inv2 = _connector_inventory()
    started = inv2["process_count"] >= 1
    r.add(Check("connector started", started,
                f"pid {proc.pid}" if started else "process exited immediately",
                f"Read {err_log} for the reason."))
    r.data["pid"] = proc.pid
    r.data["logs"] = {"stdout": str(out_log), "stderr": str(err_log)}

    url = ctx.public_url()
    if started and url:
        status = None
        for _ in range(6):
            status, _err = probe(url, timeout=10)
            if status is not None and status < 400:
                break
            time.sleep(3)
        r.add(Check("public hostname serving",
                    status is not None and status < 400,
                    f"{url} -> {status}",
                    "The connector is up but the hostname is not serving. "
                    "Run: signtoross_tunnel.py doctor"))
    return r


def cmd_down(ctx: Ctx, args: argparse.Namespace) -> Result:
    """Stop connectors started for this deployment."""
    r = Result("down")
    inv = _connector_inventory()
    procs = inv["processes"]

    if not procs:
        r.add(Check("connector stopped", True, "no cloudflared process running"))
        return r

    token_marker = str(ctx.token_file)
    stopped, skipped = [], []
    for p in procs:
        owned = token_marker in p["cmdline"] or args.all
        if not owned:
            skipped.append(p["pid"])
            continue
        if IS_WINDOWS:
            _run(["taskkill", "/PID", str(p["pid"]), "/F"])
        else:
            _run(["kill", "-TERM", str(p["pid"])])
        stopped.append(p["pid"])

    r.add(Check("connector stopped", True,
                f"stopped {stopped or 'none'}"
                + (f"; left running (not this deployment): {skipped}" if skipped else "")))
    if skipped:
        r.say("Processes not started from this token file were left alone. "
              "Pass --all to stop every cloudflared process on this host.")
    r.data["stopped"] = stopped
    r.data["skipped"] = skipped
    return r


def cmd_doctor(ctx: Ctx, args: argparse.Namespace) -> Result:
    """Sample the public hostname to expose split-brain routing.

    One connector gives a uniform result. Two connectors that disagree about
    the origin give a mix of 200 and 502 across otherwise identical requests,
    which no single request can reveal.
    """
    r = Result("doctor")
    inv = _connector_inventory()
    r.data["connectors"] = inv

    if inv["process_count"] > 1:
        r.add(Check("exactly one connector", False,
                    f"{inv['process_count']} cloudflared processes",
                    "Stop the extras, then re-run doctor."))
    else:
        r.add(Check("exactly one connector", True,
                    f"{inv['process_count']} cloudflared process"))

    url = ctx.public_url()
    if not url:
        r.add(Check("hostname configured", False, "none",
                    "Pass --hostname or set SIGNTOROSS_PUBLIC_HOSTNAME."))
        return r

    codes: list[Any] = []
    for _ in range(args.samples):
        status, err = probe(url, timeout=10)
        codes.append(status if status is not None else f"error:{err}")
        time.sleep(0.25)

    distinct = sorted({str(c) for c in codes})
    good = sum(1 for c in codes if isinstance(c, int) and c < 400)
    bad502 = sum(1 for c in codes if c == 502)

    r.data["samples"] = codes
    r.data["distinct"] = distinct
    r.data["ok_count"] = good
    r.data["bad_gateway_count"] = bad502

    if bad502 and good:
        r.add(Check("uniform responses", False,
                    f"{args.samples} requests -> {good} served, {bad502} 502 "
                    f"(codes: {', '.join(distinct)})",
                    "This is the signature of more than one connector on the "
                    "tunnel. Routes belong to the tunnel, so every connector "
                    "with its token receives them; the one that cannot reach "
                    "the origin returns 502. Stop all but the connector on "
                    "this host, then re-run."))
    elif good == args.samples:
        r.add(Check("uniform responses", True,
                    f"{args.samples}/{args.samples} served"))
    else:
        r.add(Check("uniform responses", False,
                    f"{good}/{args.samples} served (codes: {', '.join(distinct)})",
                    "The hostname is not serving consistently. Check the "
                    f"origin at {ctx.origin} and the tunnel logs."))

    status, err = probe(ctx.origin, timeout=8)
    r.add(Check("origin reachable from this host",
                status is not None and status < 500,
                f"{ctx.origin} -> {status if status else err}",
                "If the public hostname 502s while the origin answers here, "
                "the request is reaching a connector on another machine."))
    return r


# --------------------------------------------------------------------------- #
#  Entry point
# --------------------------------------------------------------------------- #

COMMANDS = {
    "preflight": cmd_preflight,
    "up": cmd_up,
    "down": cmd_down,
    "status": cmd_status,
    "doctor": cmd_doctor,
}


def build_parser() -> argparse.ArgumentParser:
    # Shared options live on a parent parser so they are accepted both before
    # and after the subcommand. An agent writing `status --json` should not
    # have to know that argparse would otherwise require `--json status`.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", help="repository root (default: current directory)")
    common.add_argument("--token-file", help=f"tunnel token file (default: {DEFAULT_TOKEN_FILE})")
    common.add_argument("--origin", help=f"local origin the route points at (default: {DEFAULT_ORIGIN})")
    common.add_argument("--hostname", help="public hostname, e.g. sign.example.com")
    common.add_argument("--json", action="store_true", help="emit a machine-readable object")

    p = argparse.ArgumentParser(
        parents=[common],
        prog="signtoross_tunnel.py",
        description="Publish a self-hosted SignToROSS signing stack through a "
                    "Cloudflare Tunnel, safely and idempotently.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:
  signtoross_tunnel.py preflight
  signtoross_tunnel.py up --hostname sign.example.com
  signtoross_tunnel.py status --json
  signtoross_tunnel.py doctor --hostname sign.example.com --samples 10
  signtoross_tunnel.py down

exit codes:
  0  healthy
  1  an actionable problem was found (every check names its remedy)
  2  misuse
""")
    p.add_argument("--version", action="version", version=f"%(prog)s {AGENT_VERSION}")

    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("preflight", parents=[common], help="check everything needed before starting")
    up = sub.add_parser("up", parents=[common], help="start exactly one connector")
    up.add_argument("--force", action="store_true",
                    help="start even when another connector is present")
    up.add_argument("--wait", type=int, default=5,
                    help="seconds to wait before verifying (default: 5)")
    down = sub.add_parser("down", parents=[common], help="stop this deployment's connector")
    down.add_argument("--all", action="store_true",
                     help="stop every cloudflared process on this host")
    sub.add_parser("status", parents=[common], help="report connectors and serving state")
    doc = sub.add_parser("doctor", parents=[common], help="diagnose intermittent 502s")
    doc.add_argument("--samples", type=int, default=10,
                     help="requests to sample (default: 10)")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    ctx = Ctx.build(args)
    handler = COMMANDS[args.command]
    try:
        result = handler(ctx, args)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 2
    return result.emit(args.json)


if __name__ == "__main__":
    raise SystemExit(main())
