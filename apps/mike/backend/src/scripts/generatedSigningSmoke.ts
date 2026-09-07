import "dotenv/config";
import { strict as assert } from "assert";
import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import type { RequestListener } from "http";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "../lib/supabase";
import { deleteFile } from "../lib/storage";
import { generateDocx } from "../lib/chatTools";

type EnvSnapshot = Record<string, string | undefined>;

const SIGNED_PDF = Buffer.from(
  "%PDF-1.4\n% mike generated signing smoke pdf\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "utf8",
);

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
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

function snapshotEnv(names: string[]): EnvSnapshot {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function startMockOpenSign() {
  return listen(async (req, res) => {
    if (req.url !== "/signed.pdf" && req.headers["x-api-token"] !== "test-token") {
      json(res, 401, { error: "missing token" });
      return;
    }

    if (req.method === "POST" && req.url === "/createdocument") {
      const body = await readJson(req);
      assert.equal(typeof body.external_id, "string");
      assert.equal(typeof body.file, "string");
      assert.equal(Array.isArray(body.signers), true);
      assert.equal(Array.isArray(body.widgets), true);
      json(res, 200, {
        objectId: "opensign-generated-smoke-1",
        status: "sent",
        Signers: [
          {
            objectId: "recipient-generated-1",
            email: "generated-signer@example.invalid",
            Status: "sent",
          },
        ],
      });
      return;
    }

    if (
      req.method === "GET" &&
      req.url === "/signinglinks/opensign-generated-smoke-1"
    ) {
      json(res, 200, {
        signingLinks: [
          {
            objectId: "recipient-generated-1",
            email: "generated-signer@example.invalid",
            signurl: "https://sign.example.invalid/request/generated-smoke",
          },
        ],
      });
      return;
    }

    if (
      req.method === "GET" &&
      req.url === "/document/opensign-generated-smoke-1"
    ) {
      const host = req.headers.host;
      json(res, 200, {
        objectId: "opensign-generated-smoke-1",
        title: "Generated Signing Smoke",
        status: "completed",
        completedAt: "2026-06-12T12:00:00.000Z",
        Signers: [
          {
            objectId: "recipient-generated-1",
            email: "generated-signer@example.invalid",
            Status: "completed",
            signedAt: "2026-06-12T12:00:00.000Z",
          },
        ],
        SignedUrl: `http://${host}/signed.pdf`,
      });
      return;
    }

    if (req.method === "GET" && req.url === "/signed.pdf") {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(SIGNED_PDF);
      return;
    }

    json(res, 404, { error: "not found" });
  });
}

async function createSmokeSession(db: ReturnType<typeof createServerSupabase>) {
  const email = `mike-generated-smoke-${crypto.randomUUID()}@example.invalid`;
  const password = `MikeGeneratedSmoke!${crypto.randomUUID()}Aa1`;
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    throw new Error(`Failed to create smoke auth user: ${createError?.message}`);
  }

  const authClient = createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SECRET_KEY ?? "",
    { auth: { persistSession: false } },
  );
  const { data: session, error: signInError } =
    await authClient.auth.signInWithPassword({ email, password });
  if (signInError || !session.session?.access_token) {
    await db.auth.admin.deleteUser(created.user.id).catch(() => undefined);
    throw new Error(`Failed to sign in smoke auth user: ${signInError?.message}`);
  }

  return {
    userId: created.user.id,
    token: session.session.access_token,
  };
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function cleanup(args: {
  db: ReturnType<typeof createServerSupabase>;
  documentId: string | null;
  userId: string | null;
}): Promise<void> {
  const { db, documentId, userId } = args;
  if (documentId) {
    const storagePaths = new Set<string>();
    const { data: versions } = await db
      .from("document_versions")
      .select("storage_path, pdf_storage_path")
      .eq("document_id", documentId);
    for (const version of versions ?? []) {
      if (typeof version.storage_path === "string") storagePaths.add(version.storage_path);
      if (typeof version.pdf_storage_path === "string") {
        storagePaths.add(version.pdf_storage_path);
      }
    }
    await db.from("documents").delete().eq("id", documentId);
    for (const path of storagePaths) {
      await deleteFile(path).catch(() => undefined);
    }
  }
  if (userId) await db.auth.admin.deleteUser(userId).catch(() => undefined);
}

async function main(): Promise<void> {
  const envSnapshot = snapshotEnv([
    "SIGNING_PROVIDER",
    "OPENSIGN_API_MODE",
    "OPENSIGN_API_BASE_URL",
    "OPENSIGN_API_TOKEN",
  ]);
  const db = createServerSupabase();
  const mock = await startMockOpenSign();
  let api: { server: http.Server; url: string } | null = null;
  let userId: string | null = null;
  let documentId: string | null = null;

  try {
    process.env.SIGNING_PROVIDER = "opensign";
    process.env.OPENSIGN_API_MODE = "token";
    process.env.OPENSIGN_API_BASE_URL = mock.url;
    process.env.OPENSIGN_API_TOKEN = "test-token";

    const { app } = await import("../index");
    api = await listen(app as unknown as RequestListener);

    const session = await createSmokeSession(db);
    userId = session.userId;

    const generated = await generateDocx(
      "Generated Signing Smoke Agreement",
      [
        {
          heading: "Parties",
          content:
            "This agreement is made between AutoYou Test Company and Smoke Signer LLC.",
        },
        {
          heading: "Electronic Signature",
          content:
            "The parties may execute this agreement by electronic signature using OpenSign.",
        },
        {
          heading: "Signatures",
          pageBreak: true,
          content:
            "AutoYou Test Company\nBy: ______________________________\nName: ____________________________\nTitle: _____________________________\nDate: ______________________________\n\nSmoke Signer LLC\nBy: ______________________________\nName: ____________________________\nTitle: _____________________________\nDate: ______________________________",
        },
      ],
      userId,
      db,
    );
    if ("error" in generated) throw new Error(String(generated.error));
    documentId = generated.document_id as string;

    const { data: version } = await db
      .from("document_versions")
      .select("storage_path, pdf_storage_path")
      .eq("document_id", documentId)
      .single();
    assert.equal(typeof version?.storage_path, "string");
    assert.equal(typeof version?.pdf_storage_path, "string");

    const headers = {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    };
    const createBody = await parseJsonResponse(
      await fetch(`${api.url}/single-documents/${documentId}/signature-requests`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          subject: "Generated signing smoke",
          message: "Please sign the generated smoke document.",
          recipients: [
            {
              name: "Generated Signer",
              email: "generated-signer@example.invalid",
              role: "SIGNER",
              signing_order: 1,
            },
          ],
        }),
      }),
    );
    assert.equal(createBody.status, "sent");
    assert.equal(createBody.provider_request_id, "opensign-generated-smoke-1");
    const requestId = String(createBody.id);

    const syncBody = await parseJsonResponse(
      await fetch(`${api.url}/signature-requests/${requestId}/sync`, {
        method: "POST",
        headers,
      }),
    );
    assert.equal(syncBody.status, "completed");
    assert.equal(typeof syncBody.signed_pdf_url, "string");
    assert.equal(typeof syncBody.signed_pdf_path, "string");

    const signedUrlBody = await parseJsonResponse(
      await fetch(`${api.url}/signature-requests/${requestId}/signed-url`, {
        headers,
      }),
    );
    assert.equal(typeof signedUrlBody.url, "string");

    console.log("Generated signing smoke passed");
    console.log(`API base: ${api.url}`);
    console.log(`Generated document: ${documentId}`);
    console.log(`Signature request: ${requestId}`);
    console.log("Verified: generated DOCX, generated PDF rendition, authenticated send, provider sync, signed-PDF import.");
  } finally {
    await cleanup({ db, documentId, userId });
    restoreEnv(envSnapshot);
    if (api) await closeServer(api.server);
    await closeServer(mock.server);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
