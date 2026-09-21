#!/usr/bin/env python3
"""Provision a host-approved account without email or public registration."""
import argparse
import json
from pathlib import Path
import secrets
import subprocess
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", required=True)
    parser.add_argument("--name", default="Mike user")
    args = parser.parse_args()
    if "@" not in args.email or any(c.isspace() for c in args.email):
        parser.error("A valid login email is required")
    credentials = {"email": args.email, "password": secrets.token_urlsafe(32)}
    payload = {**credentials, "email_confirm": True, "user_metadata": {"display_name": args.name}}
    script = """
const {createClient} = require('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY,
  {auth:{persistSession:false}});
(async () => {
  const {data,error} = await db.auth.admin.createUser(PAYLOAD);
  if (error) { console.error(error.message); process.exit(1); }
  const {error:profileError} = await db.from('user_profiles')
    .update({display_name:PAYLOAD.user_metadata.display_name}).eq('user_id',data.user.id);
  if (profileError) { console.error(profileError.message); process.exit(1); }
  console.log(JSON.stringify({id:data.user.id}));
})().catch(e=>{console.error(e.message);process.exit(1)});
""".replace("PAYLOAD", json.dumps(payload))
    directory = Path(__file__).resolve().parent
    result = subprocess.run(
        ["docker", "compose", "exec", "-T", "backend", "node", "-"],
        input=script, text=True, capture_output=True, cwd=directory,
    )
    if result.returncode:
        raise SystemExit("Account creation failed: " + result.stderr.strip())
    credentials.update(json.loads(result.stdout))
    target = directory / ".local" / f"login-{uuid.uuid4().hex[:8]}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8") as output:
        json.dump(credentials, output, indent=2)
        output.write("\n")
    target.chmod(0o600)
    print(f"Account created. Login credentials saved privately to {target.name} in services/mike/.local/.")


if __name__ == "__main__":
    main()
