#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS public.mike_deployment_migrations (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.mike_deployment_migrations FROM anon, authenticated;
SQL
applied=$(psql -Atc "SELECT count(*) FROM public.mike_deployment_migrations WHERE name='initial-schema-v1'")
if [ "$applied" = "0" ]; then
  # A single transaction keeps failed initialization retryable.
  {
    printf 'BEGIN;\n'
    cat /schema.sql
    cat <<'SQL'
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
INSERT INTO public.mike_deployment_migrations (name) VALUES ('initial-schema-v1');
COMMIT;
SQL
  } | psql -v ON_ERROR_STOP=1
fi
psql -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO storage.buckets (id, name, public) VALUES ('mike', 'mike', false)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
SQL
