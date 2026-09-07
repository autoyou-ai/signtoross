import { strict as assert } from "assert";
import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import {
  completeText,
  checkOllamaHealth,
  streamChatWithTools,
} from "../lib/llm";
import { getSigningProvider } from "../lib/signing";

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
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

function json(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function withServer<T>(
  handler: http.RequestListener,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const { server, url } = await listen(handler);
  try {
    return await fn(url);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

async function smokeOllama(): Promise<void> {
  await withServer(
    async (req, res) => {
      if (req.method === "GET" && req.url === "/api/version") {
        json(res, 200, { version: "mock" });
        return;
      }
      if (req.method === "GET" && req.url === "/api/tags") {
        json(res, 200, { models: [{ name: "local-legal:test" }] });
        return;
      }
      if (req.method === "POST" && req.url === "/api/chat") {
        const body = await readJson(req);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const sawToolResult = messages.some(
          (message) =>
            message &&
            typeof message === "object" &&
            (message as { role?: unknown }).role === "tool",
        );
        if (body.stream === false) {
          json(res, 200, {
            message: { role: "assistant", content: "complete ok" },
            done: true,
          });
          return;
        }

        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (sawToolResult) {
          res.write(
            `${JSON.stringify({
              message: { role: "assistant", content: "tool loop ok" },
              done: false,
            })}\n`,
          );
        } else if (Array.isArray(body.tools) && body.tools.length > 0) {
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    function: {
                      name: "read_document",
                      arguments: { doc_id: "doc-0" },
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
              message: { role: "assistant", content: "stream ok" },
              done: false,
            })}\n`,
          );
        }
        res.write(`${JSON.stringify({ done: true })}\n`);
        res.end();
        return;
      }
      json(res, 404, { error: "not found" });
    },
    async (url) => {
      process.env.OLLAMA_ENABLED = "true";
      process.env.OLLAMA_BASE_URL = url;
      process.env.OLLAMA_MODEL = "local-legal:test";
      process.env.OLLAMA_CLOUD_FALLBACK = "false";

      const health = await checkOllamaHealth();
      assert.equal(health.configured, true);
      assert.equal(health.reachable, true);
      assert.equal(health.modelInstalled, true);

      delete process.env.OLLAMA_ENABLED;
      delete process.env.OLLAMA_BASE_URL;
      process.env.AI_PROVIDER = "ollama";
      process.env.OLLAMA_API_BASE = url;

      const autoYouStyleHealth = await checkOllamaHealth();
      assert.equal(autoYouStyleHealth.configured, true);
      assert.equal(autoYouStyleHealth.reachable, true);
      assert.equal(autoYouStyleHealth.modelInstalled, true);

      const completion = await completeText({
        model: "ollama:default",
        user: "ping",
      });
      assert.equal(completion, "complete ok");

      const toolStarts: string[] = [];
      const result = await streamChatWithTools({
        model: "ollama:default",
        systemPrompt: "You are a test legal assistant.",
        messages: [{ role: "user", content: "Read the document." }],
        tools: [
          {
            type: "function",
            function: {
              name: "read_document",
              description: "Read a document.",
              parameters: {
                type: "object",
                properties: { doc_id: { type: "string" } },
                required: ["doc_id"],
              },
            },
          },
        ],
        callbacks: {
          onToolCallStart: (call) => toolStarts.push(call.name),
        },
        runTools: async (calls) =>
          calls.map((call) => ({
            tool_use_id: call.id,
            content: "Mock document text",
          })),
      });
      assert.deepEqual(toolStarts, ["read_document"]);
      assert.equal(result.fullText, "tool loop ok");
    },
  );
}

async function smokeOpenSign(): Promise<void> {
  await withServer(
    async (req, res) => {
      if (
        req.headers["x-api-token"] !== "test-token" &&
        req.url !== "/signed.pdf"
      ) {
        json(res, 401, { error: "missing token" });
        return;
      }

      if (req.method === "POST" && req.url === "/createdocument") {
        const body = await readJson(req);
        assert.equal(typeof body.file, "string");
        assert.equal(Array.isArray(body.signers), true);
        assert.equal(Array.isArray(body.widgets), true);
        json(res, 200, {
          objectId: "opensign-doc-1",
          status: "sent",
          Signers: [
            {
              objectId: "recipient-1",
              email: "signer@example.com",
              Status: "sent",
            },
          ],
        });
        return;
      }

      if (req.method === "GET" && req.url === "/signinglinks/opensign-doc-1") {
        const host = req.headers.host;
        json(res, 200, {
          signingLinks: [
            {
              objectId: "recipient-1",
              email: "signer@example.com",
              signurl: "https://sign.example.local/request/1",
            },
          ],
          signedUrl: `http://${host}/signed.pdf`,
        });
        return;
      }

      if (req.method === "GET" && req.url === "/document/opensign-doc-1") {
        const host = req.headers.host;
        json(res, 200, {
          title: "Smoke Test",
          status: "completed",
          completedAt: "2026-06-12T12:00:00.000Z",
          Signers: [
            {
              objectId: "recipient-1",
              email: "signer@example.com",
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
        res.end("%PDF-1.4\n% mock signed pdf\n");
        return;
      }

      json(res, 404, { error: "not found" });
    },
    async (url) => {
      process.env.SIGNING_PROVIDER = "opensign";
      process.env.OPENSIGN_API_MODE = "token";
      process.env.OPENSIGN_API_BASE_URL = url;
      process.env.OPENSIGN_API_TOKEN = "test-token";

      const provider = getSigningProvider("opensign");
      const created = await provider.createSignatureRequest({
        requestId: "00000000-0000-4000-8000-000000000001",
        documentId: "doc-1",
        title: "Smoke Test",
        filename: "smoke.pdf",
        pdfBytes: toArrayBuffer(Buffer.from("%PDF-1.4\n")),
        pageCount: 1,
        subject: "Please sign",
        message: "Test message",
        expiresAt: null,
        recipients: [
          {
            name: "Test Signer",
            email: "signer@example.com",
            role: "SIGNER",
            signingOrder: 1,
          },
        ],
      });
      assert.equal(created.providerRequestId, "opensign-doc-1");
      assert.equal(created.status, "sent");
      assert.equal(
        created.recipients[0]?.signingUrl,
        "https://sign.example.local/request/1",
      );

      const status = await provider.getSignatureRequestStatus?.(
        "opensign-doc-1",
        [
          {
            name: "Test Signer",
            email: "signer@example.com",
            role: "SIGNER",
            signingOrder: 1,
          },
        ],
      );
      assert.equal(status?.status, "completed");
      assert.equal(status?.completedAt, "2026-06-12T12:00:00.000Z");
      assert.equal(status?.recipients[0]?.status, "signed");
      assert.equal(
        status?.recipients[0]?.signingUrl,
        "https://sign.example.local/request/1",
      );

      const signed = await provider.downloadSignedPdf("opensign-doc-1");
      assert.equal(signed.bytes.toString("utf8").startsWith("%PDF-1.4"), true);
      assert.equal(signed.filename.endsWith("_signed.pdf"), true);

      const webhookEnv = {
        NODE_ENV: process.env.NODE_ENV,
        OPENSIGN_WEBHOOK_SECRET: process.env.OPENSIGN_WEBHOOK_SECRET,
        PUBLIC_WEBHOOK_REQUIRED: process.env.PUBLIC_WEBHOOK_REQUIRED,
        OPENSIGN_WEBHOOK_REQUIRED: process.env.OPENSIGN_WEBHOOK_REQUIRED,
        OPEN_SIGN_WEBHOOK_REQUIRED: process.env.OPEN_SIGN_WEBHOOK_REQUIRED,
      };
      try {
        delete process.env.OPENSIGN_WEBHOOK_SECRET;
        delete process.env.PUBLIC_WEBHOOK_REQUIRED;
        delete process.env.OPENSIGN_WEBHOOK_REQUIRED;
        delete process.env.OPEN_SIGN_WEBHOOK_REQUIRED;
        process.env.NODE_ENV = "development";
        const rawBody = Buffer.from(
          JSON.stringify({
            event: "DOCUMENT_COMPLETED",
            payload: { objectId: "opensign-doc-1" },
          }),
        );
        assert.equal(
          provider.verifyWebhook({ headers: {}, rawBody, body: {} }),
          true,
        );

        process.env.PUBLIC_WEBHOOK_REQUIRED = "true";
        assert.equal(
          provider.verifyWebhook({ headers: {}, rawBody, body: {} }),
          false,
        );

        process.env.OPENSIGN_WEBHOOK_SECRET = "test-webhook-secret";
        const signature = crypto
          .createHmac("sha256", process.env.OPENSIGN_WEBHOOK_SECRET)
          .update(rawBody)
          .digest("hex");
        assert.equal(
          provider.verifyWebhook({
            headers: { "x-webhook-signature": `sha256=${signature}` },
            rawBody,
            body: {},
          }),
          true,
        );
        assert.equal(
          provider.verifyWebhook({
            headers: { "x-webhook-signature": "sha256=bad" },
            rawBody,
            body: {},
          }),
          false,
        );
      } finally {
        for (const [name, value] of Object.entries(webhookEnv)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    },
  );
}

async function main(): Promise<void> {
  await smokeOllama();
  await smokeOpenSign();
  console.log("Adapter smoke tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
