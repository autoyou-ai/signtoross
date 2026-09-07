import "dotenv/config";
import { strict as assert } from "assert";
import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import type { RequestListener } from "http";
import { createServerSupabase } from "../lib/supabase";

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(names: string[]): EnvSnapshot {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

async function main(): Promise<void> {
  const envSnapshot = snapshotEnv([
    "NODE_ENV",
    "SIGNING_PROVIDER",
    "OPENSIGN_API_MODE",
    "MIKE_PUBLIC_API_BASE_URL",
    "PUBLIC_WEBHOOK_REQUIRED",
    "OPENSIGN_WEBHOOK_REQUIRED",
    "OPEN_SIGN_WEBHOOK_REQUIRED",
    "OPENSIGN_API_TOKEN",
    "OPENSIGN_WEBHOOK_SECRET",
  ]);
  const providerRequestId = `opensign-public-rejection-${crypto.randomUUID()}`;
  const db = createServerSupabase();
  let api: { server: http.Server; url: string } | null = null;

  try {
    process.env.NODE_ENV = "development";
    process.env.SIGNING_PROVIDER = "opensign";
    process.env.OPENSIGN_API_MODE = "token";
    process.env.PUBLIC_WEBHOOK_REQUIRED = "true";
    delete process.env.OPENSIGN_WEBHOOK_REQUIRED;
    delete process.env.OPEN_SIGN_WEBHOOK_REQUIRED;
    delete process.env.OPENSIGN_WEBHOOK_SECRET;

    const { app } = await import("../index");
    api = await listen(app as unknown as RequestListener);

    const healthResponse = await fetch(`${api.url}/health/integrations`);
    const health = (await healthResponse.json()) as {
      opensign?: Record<string, unknown>;
    };
    assert.equal(healthResponse.status, 200);
    assert.equal(health.opensign?.webhookSecretRequired, true);
    assert.equal(health.opensign?.webhookSecretConfigured, false);
    assert.equal(health.opensign?.webhookReadyForPublic, false);
    assert.equal(health.opensign?.readyForPublicSigning, false);

    const payload = {
      event: "DOCUMENT_COMPLETED",
      createdAt: new Date().toISOString(),
      payload: {
        objectId: providerRequestId,
        status: "completed",
      },
    };

    const response = await fetch(`${api.url}/webhooks/signing/opensign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    assert.equal(response.status, 401);
    assert.equal(body.detail, "Unauthorized");

    const { data: events, error } = await db
      .from("signature_events")
      .select("id")
      .eq("provider", "opensign")
      .eq("provider_request_id", providerRequestId);
    if (error) throw new Error(error.message);
    assert.equal((events ?? []).length, 0);

    process.env.MIKE_PUBLIC_API_BASE_URL = "https://mike.example.invalid";
    process.env.OPENSIGN_API_TOKEN = "test-token";
    process.env.OPENSIGN_WEBHOOK_SECRET = "test-webhook-secret";
    const readyHealthResponse = await fetch(`${api.url}/health/integrations`);
    const readyHealth = (await readyHealthResponse.json()) as {
      opensign?: Record<string, unknown>;
    };
    assert.equal(readyHealthResponse.status, 200);
    assert.equal(readyHealth.opensign?.configured, true);
    assert.equal(readyHealth.opensign?.webhookSecretRequired, true);
    assert.equal(readyHealth.opensign?.webhookSecretConfigured, true);
    assert.equal(
      readyHealth.opensign?.webhookTarget,
      "https://mike.example.invalid/webhooks/signing/opensign",
    );
    assert.equal(readyHealth.opensign?.webhookTargetPublic, true);
    assert.equal(readyHealth.opensign?.webhookReadyForPublic, true);
    assert.equal(readyHealth.opensign?.readyForPublicSigning, true);

    console.log("Public webhook readiness smoke passed");
    console.log(
      "Verified: unsafe public webhook mode rejects unsigned OpenSign callbacks before event recording, and configured public webhook health reports ready for public signing.",
    );
  } finally {
    await db
      .from("signature_events")
      .delete()
      .eq("provider", "opensign")
      .eq("provider_request_id", providerRequestId)
      .then(
        () => undefined,
        () => undefined,
      );
    restoreEnv(envSnapshot);
    if (api) await closeServer(api.server);
  }
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exitCode = 1;
});
