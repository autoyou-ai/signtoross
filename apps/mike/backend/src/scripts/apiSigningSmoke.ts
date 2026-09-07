import "dotenv/config";
import { strict as assert } from "assert";
import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import type { RequestListener } from "http";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "../lib/supabase";
import { storageKey, uploadFile, deleteFile } from "../lib/storage";

type EnvSnapshot = Record<string, string | undefined>;

const SOURCE_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "utf8",
);
const SIGNED_PDF = Buffer.from(
  "%PDF-1.4\n% mike api signed smoke pdf\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "utf8",
);

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function json(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
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

async function listenExpress(app: RequestListener) {
  return listen(app);
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

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

async function startMockOpenSign() {
  return listen(async (req, res) => {
    if (
      req.url !== "/signed.pdf" &&
      req.headers["x-api-token"] !== "test-token"
    ) {
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
        objectId: "opensign-api-smoke-1",
        status: "sent",
        Signers: [
          {
            objectId: "recipient-api-1",
            email: "api-signer@example.invalid",
            Status: "sent",
          },
        ],
      });
      return;
    }

    if (
      req.method === "GET" &&
      req.url === "/signinglinks/opensign-api-smoke-1"
    ) {
      json(res, 200, {
        signingLinks: [
          {
            objectId: "recipient-api-1",
            email: "api-signer@example.invalid",
            signurl: "https://sign.example.invalid/request/api-smoke",
          },
        ],
      });
      return;
    }

    if (req.method === "GET" && req.url === "/document/opensign-api-smoke-1") {
      const host = req.headers.host;
      json(res, 200, {
        objectId: "opensign-api-smoke-1",
        title: "API OpenSign Smoke",
        status: "completed",
        completedAt: "2026-06-12T12:00:00.000Z",
        Signers: [
          {
            objectId: "recipient-api-1",
            email: "api-signer@example.invalid",
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

async function startMockOllama() {
  return listen(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      json(res, 200, { models: [{ name: "local-legal:test" }] });
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(
        `${JSON.stringify({ message: { role: "assistant", content: "chat persistence ok" } })}\n${JSON.stringify({ done: true })}\n`,
      );
      return;
    }
    json(res, 404, { error: "not found" });
  });
}

async function createSmokeSession(db: ReturnType<typeof createServerSupabase>) {
  const email = `mike-api-smoke-${crypto.randomUUID()}@example.invalid`;
  const password = `MikeApiSmoke!${crypto.randomUUID()}Aa1`;
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    throw new Error(
      `Failed to create smoke auth user: ${createError?.message}`,
    );
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
    throw new Error(
      `Failed to sign in smoke auth user: ${signInError?.message}`,
    );
  }

  return {
    userId: created.user.id,
    email,
    token: session.session.access_token,
  };
}

async function parseJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function cleanupSmokeRows(args: {
  db: ReturnType<typeof createServerSupabase>;
  documentId: string;
  chatId: string | null;
  userId: string | null;
  storagePaths: Set<string>;
}): Promise<void> {
  const { db, documentId, chatId, userId, storagePaths } = args;
  const { data: versions } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .eq("document_id", documentId);
  for (const version of versions ?? []) {
    if (typeof version.storage_path === "string")
      storagePaths.add(version.storage_path);
    if (typeof version.pdf_storage_path === "string") {
      storagePaths.add(version.pdf_storage_path);
    }
  }
  await db.from("documents").delete().eq("id", documentId);
  if (chatId) await db.from("chats").delete().eq("id", chatId);
  if (userId) await db.auth.admin.deleteUser(userId).catch(() => undefined);
  for (const path of storagePaths) {
    await deleteFile(path).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const envSnapshot = snapshotEnv([
    "SIGNING_PROVIDER",
    "OPENSIGN_API_MODE",
    "OPENSIGN_API_BASE_URL",
    "OPENSIGN_API_TOKEN",
    "AI_PROVIDER",
    "OLLAMA_ENABLED",
    "OLLAMA_BASE_URL",
    "OLLAMA_MODEL",
    "OLLAMA_CLOUD_FALLBACK",
  ]);
  const db = createServerSupabase();
  const mock = await startMockOpenSign();
  const mockOllama = await startMockOllama();
  let api: { server: http.Server; url: string } | null = null;
  let userId: string | null = null;
  let chatId: string | null = null;
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const storagePaths = new Set<string>();

  try {
    process.env.SIGNING_PROVIDER = "opensign";
    process.env.OPENSIGN_API_MODE = "token";
    process.env.OPENSIGN_API_BASE_URL = mock.url;
    process.env.OPENSIGN_API_TOKEN = "test-token";
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_ENABLED = "true";
    process.env.OLLAMA_BASE_URL = mockOllama.url;
    process.env.OLLAMA_MODEL = "local-legal:test";
    process.env.OLLAMA_CLOUD_FALLBACK = "false";

    const { app } = await import("../index");
    api = await listenExpress(app as unknown as RequestListener);

    const session = await createSmokeSession(db);
    userId = session.userId;
    const sourceKey = storageKey(userId, documentId, "api-opensign-smoke.pdf");
    storagePaths.add(sourceKey);
    await uploadFile(sourceKey, toArrayBuffer(SOURCE_PDF), "application/pdf");

    const now = new Date().toISOString();
    const { error: docError } = await db.from("documents").insert({
      id: documentId,
      project_id: null,
      user_id: userId,
      filename: "api-opensign-smoke.pdf",
      file_type: "pdf",
      size_bytes: SOURCE_PDF.byteLength,
      page_count: 1,
      status: "ready",
      created_at: now,
      updated_at: now,
    });
    if (docError) throw new Error(docError.message);

    const { error: versionError } = await db.from("document_versions").insert({
      id: versionId,
      document_id: documentId,
      storage_path: sourceKey,
      pdf_storage_path: sourceKey,
      source: "generated",
      version_number: 1,
      display_name: "api-opensign-smoke.pdf",
    });
    if (versionError) throw new Error(versionError.message);

    const { error: docUpdateError } = await db
      .from("documents")
      .update({ current_version_id: versionId })
      .eq("id", documentId);
    if (docUpdateError) throw new Error(docUpdateError.message);

    const headers = {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    };

    const chatResponse = await fetch(`${api.url}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "ollama:default",
        messages: [
          {
            role: "user",
            content: "Persist this user message.",
            workflow: {
              id: "workflow-smoke",
              title: "Workflow Smoke",
            },
          },
        ],
      }),
    });
    assert.equal(chatResponse.ok, true);
    const chatStream = await chatResponse.text();
    const chatIdMatch = chatStream.match(/"chatId":"([^"]+)"/);
    assert.ok(chatIdMatch?.[1]);
    chatId = chatIdMatch[1];
    const { data: chatRows, error: chatRowsError } = await db
      .from("chat_messages")
      .select("role, content, workflow")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });
    if (chatRowsError) throw new Error(chatRowsError.message);
    assert.equal(chatRows?.length, 2);
    assert.equal(chatRows?.[0]?.role, "user");
    assert.equal(chatRows?.[0]?.content, "Persist this user message.");
    assert.equal(
      (chatRows?.[0]?.workflow as { title?: string } | null)?.title,
      "Workflow Smoke",
    );
    assert.equal(chatRows?.[1]?.role, "assistant");

    const createBody = await parseJsonResponse(
      await fetch(
        `${api.url}/single-documents/${documentId}/signature-requests`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            subject: "API OpenSign smoke",
            message: "Please sign the API smoke document.",
            recipients: [
              {
                name: "API Signer",
                email: "api-signer@example.invalid",
                role: "SIGNER",
                signing_order: 1,
              },
            ],
          }),
        },
      ),
    );
    assert.equal(createBody.status, "sent");
    assert.equal(createBody.provider_request_id, "opensign-api-smoke-1");
    const requestId = String(createBody.id);
    const recipients = createBody.recipients as Record<string, unknown>[];
    assert.equal(
      recipients[0]?.signing_url,
      "https://sign.example.invalid/request/api-smoke",
    );

    const listBody = await parseJsonResponse(
      await fetch(
        `${api.url}/single-documents/${documentId}/signature-requests`,
        {
          headers,
        },
      ),
    );
    const requests = listBody.requests as Record<string, unknown>[];
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.id, requestId);

    const syncBody = await parseJsonResponse(
      await fetch(`${api.url}/signature-requests/${requestId}/sync`, {
        method: "POST",
        headers,
      }),
    );
    assert.equal(syncBody.status, "completed");
    assert.equal(typeof syncBody.signed_pdf_url, "string");

    const detailBody = await parseJsonResponse(
      await fetch(`${api.url}/signature-requests/${requestId}`, {
        headers,
      }),
    );
    assert.equal(detailBody.status, "completed");
    assert.equal(typeof detailBody.signed_pdf_path, "string");
    assert.equal(typeof detailBody.signed_pdf_url, "string");

    const signedUrlBody = await parseJsonResponse(
      await fetch(`${api.url}/signature-requests/${requestId}/signed-url`, {
        headers,
      }),
    );
    assert.equal(typeof signedUrlBody.url, "string");
    assert.equal(
      typeof signedUrlBody.filename === "string" &&
        signedUrlBody.filename.endsWith("[Signed].pdf"),
      true,
    );

    console.log("API signing smoke passed");
    console.log(`API base: ${api.url}`);
    console.log(`Document: ${documentId}`);
    console.log(`Signature request: ${requestId}`);
    console.log(
      "Verified: auth, chat user/assistant persistence, route create/list/sync/detail/signed-url, storage, signed-PDF import.",
    );
  } finally {
    await cleanupSmokeRows({
      db,
      documentId,
      chatId,
      userId,
      storagePaths,
    });
    restoreEnv(envSnapshot);
    if (api) await closeServer(api.server);
    await closeServer(mock.server);
    await closeServer(mockOllama.server);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
