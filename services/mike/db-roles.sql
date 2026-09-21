-- psql reads secrets from the container environment, never source control.
\getenv pgpass POSTGRES_PASSWORD
\getenv jwt_secret JWT_SECRET
\getenv jwt_exp JWT_EXP
ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
