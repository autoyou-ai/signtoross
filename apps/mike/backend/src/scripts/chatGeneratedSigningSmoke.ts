import "dotenv/config";
import { strict as assert } from "assert";
import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import type { RequestListener } from "http";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "../lib/supabase";
import { deleteFile } from "../lib/storage";

type EnvSnapshot = Record<string, string | undefined>;

const SIGNED_PDF = Buffer.from(
  "%PDF-1.4\n% mike chat generated signing smoke pdf\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "utf8",
);

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

function sseEvent(line: string): Record<string, unknown> | null {
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice("data: ".length).trim();
  if (!payload || payload === "[DONE]") return null;
  return JSON.parse(payload) as Record<string, unknown>;
}

function parseSse(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map(sseEvent)
    .filter((event): event is Record<string, unknown> => !!event);
}

async function startMockOllama() {
  const stats = {
    chatCalls: 0,
    sawGeneratedDocumentToolResult: false,
    sawReadDocumentToolResult: false,
  };
  const server = await listen(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/version") {
      json(res, 200, { version: "mock-chat-generated-signing" });
      return;
    }
    if (req.method === "GET" && req.url === "/api/tags") {
      json(res, 200, { models: [{ name: "local-legal:test" }] });
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      stats.chatCalls += 1;
      const body = await readJson(req);
      const messages = Array.isArray(body.messages)
        ? (body.messages as Record<string, unknown>[])
        : [];
      const toolMessages = messages.filter(
        (message) => message.role === "tool",
      );
      for (const message of toolMessages) {
        const content =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? "");
        if (content.includes("doc_id")) {
          stats.sawGeneratedDocumentToolResult = true;
        }
        if (content.includes("CHAT GENERATED SIGNING SMOKE AGREEMENT")) {
          stats.sawReadDocumentToolResult = true;
        }
      }

      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (toolMessages.length === 0) {
        res.write(
          `${JSON.stringify({
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call-generate-docx",
                  function: {
                    name: "generate_docx",
                    arguments: {
                      title: "Chat Generated Signing Smoke Agreement",
                      sections: [
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
                    },
                  },
                },
              ],
            },
            done: false,
          })}\n`,
        );
      } else if (toolMessages.length === 1) {
        const firstToolContent =
          typeof toolMessages[0]?.content === "string"
            ? (toolMessages[0].content as string)
            : "{}";
        const docId =
          (JSON.parse(firstToolContent) as { doc_id?: string }).doc_id ??
          "doc-0";
        res.write(
          `${JSON.stringify({
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call-read-generated-doc",
                  function: {
                    name: "read_document",
                    arguments: { doc_id: docId },
                  },
                },
              ],
            },
            done: false,
          })}\n`,
        );
      } else {
        res.write(
          `${JSON.stringify({
            message: {
              role: "assistant",
              content:
                "The generated agreement is ready for signature monitoring through OpenSign.",
            },
            done: false,
          })}\n`,
        );
      }
      res.write(`${JSON.stringify({ done: true })}\n`);
      res.end();
      return;
    }
    json(res, 404, { error: "not found" });
  });
  return { ...server, stats };
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
        objectId: "opensign-chat-generated-smoke-1",
        status: "sent",
        Signers: [
          {
            objectId: "recipient-chat-generated-1",
            email: "chat-generated-signer@example.invalid",
            Status: "sent",
          },
        ],
      });
      return;
    }

    if (
      req.method === "GET" &&
      req.url === "/signinglinks/opensign-chat-generated-smoke-1"
    ) {
      json(res, 200, {
        signingLinks: [
          {
            objectId: "recipient-chat-generated-1",
            email: "chat-generated-signer@example.invalid",
            signurl:
              "https://sign.example.invalid/request/chat-generated-smoke",
          },
        ],
      });
      return;
    }

    if (
      req.method === "GET" &&
      req.url === "/document/opensign-chat-generated-smoke-1"
    ) {
      const host = req.headers.host;
      json(res, 200, {
        objectId: "opensign-chat-generated-smoke-1",
        title: "Chat Generated Signing Smoke",
        status: "completed",
        completedAt: "2026-06-12T12:00:00.000Z",
        Signers: [
          {
            objectId: "recipient-chat-generated-1",
            email: "chat-generated-signer@example.invalid",
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
  const email = `mike-chat-generated-smoke-${crypto.randomUUID()}@example.invalid`;
  const password = `MikeChatGeneratedSmoke!${crypto.randomUUID()}Aa1`;
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

async function postCompletedWebhook(args: {
  apiUrl: string;
  requestId: string;
  providerRequestId: string;
  secret: string;
}): Promise<Record<string, unknown>> {
  const completedAt = new Date().toISOString();
  const payload = {
    event: "DOCUMENT_COMPLETED",
    createdAt: completedAt,
    payload: {
      objectId: args.providerRequestId,
      external_id: `mike-signature-request:${args.requestId}`,
      status: "completed",
      completedAt,
      Signers: [
        {
          objectId: "recipient-chat-generated-1",
          email: "chat-generated-signer@example.invalid",
          Status: "completed",
          signedAt: completedAt,
        },
      ],
    },
  };
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", args.secret)
    .update(body)
    .digest("hex");

  return parseJsonResponse(
    await fetch(`${args.apiUrl}/webhooks/signing/opensign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": `sha256=${signature}`,
      },
      body,
    }),
  );
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
      if (typeof version.storage_path === "string")
        storagePaths.add(version.storage_path);
      if (typeof version.pdf_storage_path === "string") {
        storagePaths.add(version.pdf_storage_path);
      }
    }
    await db.from("documents").delete().eq("id", documentId);
    for (const path of storagePaths) {
      await deleteFile(path).catch(() => undefined);
    }
  }
  if (userId) {
    await db
      .from("chats")
      .delete()
      .eq("user_id", userId)
      .then(
        () => undefined,
        () => undefined,
      );
    await db.auth.admin.deleteUser(userId).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const webhookMode = process.argv.includes("--webhook");
  const envSnapshot = snapshotEnv([
    "AI_PROVIDER",
    "OLLAMA_ENABLED",
    "OLLAMA_API_BASE",
    "OLLAMA_BASE_URL",
    "OLLAMA_MODEL",
    "OLLAMA_CLOUD_FALLBACK",
    "SIGNING_PROVIDER",
    "OPENSIGN_API_MODE",
    "OPENSIGN_API_BASE_URL",
    "OPENSIGN_API_TOKEN",
    "OPENSIGN_WEBHOOK_SECRET",
  ]);
  const db = createServerSupabase();
  const mockOllama = await startMockOllama();
  const mockOpenSign = await startMockOpenSign();
  let api: { server: http.Server; url: string } | null = null;
  let userId: string | null = null;
  let documentId: string | null = null;

  try {
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_ENABLED = "true";
    process.env.OLLAMA_API_BASE = mockOllama.url;
    process.env.OLLAMA_BASE_URL = mockOllama.url;
    process.env.OLLAMA_MODEL = "local-legal:test";
    process.env.OLLAMA_CLOUD_FALLBACK = "false";
    process.env.SIGNING_PROVIDER = "opensign";
    process.env.OPENSIGN_API_MODE = "token";
    process.env.OPENSIGN_API_BASE_URL = mockOpenSign.url;
    process.env.OPENSIGN_API_TOKEN = "test-token";
    if (webhookMode) {
      process.env.OPENSIGN_WEBHOOK_SECRET = "test-webhook-secret";
    }

    const { app } = await import("../index");
    api = await listen(app as unknown as RequestListener);

    const session = await createSmokeSession(db);
    userId = session.userId;
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
            content:
              "Draft a short agreement with an OpenSign electronic signature clause.",
          },
        ],
      }),
    });
    const chatText = await chatResponse.text();
    if (!chatResponse.ok) {
      throw new Error(`Chat failed: HTTP ${chatResponse.status} ${chatText}`);
    }
    const events = parseSse(chatText);
    const created = events.find((event) => event.type === "doc_created");
    assert.equal(typeof created?.document_id, "string");
    if (typeof created?.document_id !== "string") {
      throw new Error("Chat did not emit a generated document id");
    }
    documentId = created.document_id as string;
    assert.equal(events.length > 0, true);
    assert.equal(
      mockOllama.stats.chatCalls >= 2,
      true,
      `Expected at least two mock Ollama chat calls, saw ${JSON.stringify(mockOllama.stats)}`,
    );
    assert.equal(
      mockOllama.stats.sawGeneratedDocumentToolResult,
      true,
      `Expected generated-document tool result, saw ${JSON.stringify(mockOllama.stats)}`,
    );
    assert.equal(
      mockOllama.stats.sawReadDocumentToolResult,
      true,
      `Expected read-document tool result, saw ${JSON.stringify(mockOllama.stats)}`,
    );

    const { data: version } = await db
      .from("document_versions")
      .select("storage_path, pdf_storage_path")
      .eq("document_id", documentId)
      .single();
    assert.equal(typeof version?.storage_path, "string");
    assert.equal(typeof version?.pdf_storage_path, "string");

    const createBody = await parseJsonResponse(
      await fetch(
        `${api.url}/single-documents/${documentId}/signature-requests`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            subject: "Chat generated signing smoke",
            message: "Please sign the chat generated smoke document.",
            recipients: [
              {
                name: "Chat Generated Signer",
                email: "chat-generated-signer@example.invalid",
                role: "SIGNER",
                signing_order: 1,
              },
            ],
          }),
        },
      ),
    );
    assert.equal(createBody.status, "sent");
    assert.equal(
      createBody.provider_request_id,
      "opensign-chat-generated-smoke-1",
    );
    const requestId = String(createBody.id);

    let completedBody: Record<string, unknown>;
    if (webhookMode) {
      const webhookBody = await postCompletedWebhook({
        apiUrl: api.url,
        requestId,
        providerRequestId: "opensign-chat-generated-smoke-1",
        secret: process.env.OPENSIGN_WEBHOOK_SECRET ?? "",
      });
      assert.equal(webhookBody.received, true);
      assert.equal(webhookBody.matched, true);
      completedBody = await parseJsonResponse(
        await fetch(`${api.url}/signature-requests/${requestId}`, {
          method: "GET",
          headers,
        }),
      );
    } else {
      completedBody = await parseJsonResponse(
        await fetch(`${api.url}/signature-requests/${requestId}/sync`, {
          method: "POST",
          headers,
        }),
      );
    }
    assert.equal(completedBody.status, "completed");
    assert.equal(typeof completedBody.signed_pdf_url, "string");
    assert.equal(typeof completedBody.signed_pdf_path, "string");
    const recipients = Array.isArray(completedBody.recipients)
      ? completedBody.recipients
      : [];
    assert.equal(
      recipients.some(
        (recipient) =>
          typeof recipient === "object" &&
          recipient !== null &&
          ["signed", "completed"].includes(
            String((recipient as Record<string, unknown>).status),
          ),
      ),
      true,
    );

    const signedUrlBody = await parseJsonResponse(
      await fetch(`${api.url}/signature-requests/${requestId}/signed-url`, {
        method: "GET",
        headers,
      }),
    );
    assert.equal(typeof signedUrlBody.url, "string");
    assert.equal(typeof signedUrlBody.filename, "string");

    if (webhookMode) {
      const { data: events, error: eventError } = await db
        .from("signature_events")
        .select("event_type, provider_request_id")
        .eq("signature_request_id", requestId);
      if (eventError) throw new Error(eventError.message);
      assert.equal(
        (events ?? []).some(
          (event) =>
            event.event_type === "DOCUMENT_COMPLETED" &&
            event.provider_request_id === "opensign-chat-generated-smoke-1",
        ),
        true,
      );
    }

    console.log(
      webhookMode
        ? "Chat generated signing webhook smoke passed"
        : "Chat generated signing smoke passed",
    );
    console.log(`API base: ${api.url}`);
    console.log(`Generated document: ${documentId}`);
    console.log(`Signature request: ${requestId}`);
    console.log(
      webhookMode
        ? "Verified: /chat Ollama tool loop, generated DOCX/PDF rendition, authenticated OpenSign send, signed webhook completion, recipient status update, webhook event recording, signed-PDF import, and signed URL generation."
        : "Verified: /chat Ollama tool loop, generated DOCX/PDF rendition, authenticated OpenSign send, provider sync, signed-PDF import, and signed URL generation.",
    );
  } finally {
    await cleanup({ db, documentId, userId });
    restoreEnv(envSnapshot);
    if (api) await closeServer(api.server);
    await closeServer(mockOpenSign.server);
    await closeServer(mockOllama.server);
  }
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exitCode = 1;
});
