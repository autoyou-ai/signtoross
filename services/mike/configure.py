#!/usr/bin/env python3
"""Create deployment secrets without printing them or overwriting an install."""
import argparse
import base64
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import time
from urllib.parse import urlsplit


def encode(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def token(role, secret):
    now = int(time.time())
    header = encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = encode(json.dumps({
        "role": role, "iss": "supabase", "iat": now,
        "exp": now + 2 * 365 * 24 * 3600,
    }).encode())
    body = f"{header}.{payload}"
    signature = encode(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{signature}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-url", required=True)
    parser.add_argument("--ollama-model", required=True, help="An installed Ollama model with tool support")
    parser.add_argument("--port", type=int, default=3052)
    args = parser.parse_args()
    url = args.public_url.rstrip("/")
    if any(character.isspace() for character in url):
        parser.error("Public URL cannot contain whitespace")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:+-]*", args.ollama_model):
        parser.error("Invalid Ollama model name")
    parsed = urlsplit(url)
    if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        parser.error("Use an origin URL without credentials, path, query or fragment")
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")
    ):
        parser.error("Public hosting requires HTTPS; HTTP is allowed only on loopback")
    if not 1024 <= args.port <= 65535:
        parser.error("Port must be between 1024 and 65535")
    directory = Path(__file__).resolve().parent
    if any((directory / name).exists() for name in (".env", ".env.backend")):
        parser.error("Deployment already configured; edit its ignored env files explicitly")
    jwt_secret = secrets.token_hex(32)
    values = {
        "PUBLIC_URL": url, "MIKE_PORT": str(args.port),
        "POSTGRES_PASSWORD": secrets.token_hex(32), "JWT_SECRET": jwt_secret,
        "ANON_KEY": token("anon", jwt_secret),
        "SERVICE_ROLE_KEY": token("service_role", jwt_secret),
        "S3_ACCESS_KEY": secrets.token_hex(16), "S3_SECRET_KEY": secrets.token_hex(32),
        "DOWNLOAD_SIGNING_SECRET": secrets.token_hex(32),
        "USER_API_KEYS_ENCRYPTION_SECRET": secrets.token_hex(32),
    }
    with (directory / ".env").open("x", encoding="utf-8", newline="\n") as target:
        target.write("".join(f"{key}={value}\n" for key, value in values.items()))
    with (directory / ".env.backend").open("x", encoding="utf-8", newline="\n") as target:
        target.write(
            "AI_PROVIDER=ollama\nOLLAMA_ENABLED=true\n"
            "OLLAMA_API_BASE=http://host.docker.internal:11434\n"
            f"OLLAMA_MODEL={args.ollama_model}\nOLLAMA_CLOUD_FALLBACK=false\n"
            "OLLAMA_CHAT_TIMEOUT_MS=300000\nOLLAMA_NUM_CTX=32768\n"
            "OLLAMA_NUM_PREDICT=4096\nOLLAMA_TEMPERATURE=0.2\n"
            "PUBLIC_WEBHOOK_REQUIRED=true\nSIGNING_PROVIDER=opensign\n"
            "OPENSIGN_SELFHOST_SEND_EMAIL=false\n"
        )
    for name in (".env", ".env.backend"):
        (directory / name).chmod(0o600)
    print(f"Configured {url} on loopback port {args.port}; secrets saved only in ignored env files.")


if __name__ == "__main__":
    main()
