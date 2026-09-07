import "dotenv/config";
import { strict as assert } from "assert";
import http from "http";
import type { AddressInfo } from "net";
import {
  checkAutoYouRuntime,
  requestAutoYouLegalAdvice,
} from "../lib/autoyouRuntime";

type EnvSnapshot = Record<string, string | undefined>;

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
): Promise<{ server: http.Server; url: string; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
  };
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

async function startMockAutoYouChat() {
  const seen: Record<string, unknown>[] = [];
  const listener = await listen(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
      const body = await readJson(req);
      seen.push(body);
      assert.equal(typeof body.message, "string");
      assert.match(String(body.message), /OpenSign/i);
      const metadata =
        body.metadata && typeof body.metadata === "object"
          ? (body.metadata as Record<string, unknown>)
          : {};
      assert.equal(metadata.client, "mike");
      assert.equal(metadata.purpose, "signtoross_probe");
      assert.equal(metadata.ai_provider, "ollama");
      assert.equal(metadata.ollama_model, "local-legal:test");
      json(res, 200, {
        response:
          "Using the local Ollama legal model, the parties may consent to electronic execution through OpenSign, and the signed copy should be retained with the final agreement.",
        session_id: body.session_id ?? "autoyou-signtoross-legal-advice-probe",
        message_id: "mock-signtoross-message-1",
        agent_name: "root_agent",
        metadata: {
          ai_provider: "ollama",
          model: "local-legal:test",
        },
      });
      return;
    }
    json(res, 404, { error: "not found" });
  });
  return { ...listener, seen };
}

async function startMockAutoYouAdmin(aiAgentPort: number) {
  return listen(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/status") {
      json(res, 200, {
        status: "running",
        service: "autoyou-admin",
        instance: {
          ports: {
            admin: 8001,
            ai_agent: aiAgentPort,
          },
        },
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/server-config") {
      json(res, 200, {
        ai_provider: "ollama",
        ollama: {
          api_base: process.env.OLLAMA_API_BASE,
          model: process.env.OLLAMA_MODEL,
        },
      });
      return;
    }
    json(res, 404, { error: "not found" });
  });
}

async function main(): Promise<void> {
  const envSnapshot = snapshotEnv([
    "AI_PROVIDER",
    "OLLAMA_ENABLED",
    "OLLAMA_API_BASE",
    "OLLAMA_BASE_URL",
    "OLLAMA_MODEL",
    "AUTOYOU_ADMIN_API_BASE",
    "AUTOYOU_ADMIN_BASE_URL",
    "AUTOYOU_RUNTIME_API_BASE",
    "AUTOYOU_CHAT_API_BASE",
    "AUTOYOU_AI_API_BASE",
    "AUTOYOU_AI_AGENT_API_BASE",
    "AUTOYOU_AI_PORT",
    "AUTOYOU_AI_AGENT_SERVER_PORT",
    "AUTOYOU_RUNTIME_REQUIRED",
    "AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED",
  ]);
  const chat = await startMockAutoYouChat();
  const admin = await startMockAutoYouAdmin(chat.port);

  try {
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_ENABLED = "true";
    process.env.OLLAMA_API_BASE = "http://127.0.0.1:11434";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    process.env.OLLAMA_MODEL = "local-legal:test";
    process.env.AUTOYOU_ADMIN_API_BASE = admin.url;
    process.env.AUTOYOU_CHAT_API_BASE = chat.url;
    process.env.AUTOYOU_RUNTIME_REQUIRED = "true";
    process.env.AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED = "true";

    const health = await checkAutoYouRuntime(2000);
    assert.equal(health.reachable, true);
    assert.equal(health.envAligned, true);
    assert.equal(health.baseUrl, admin.url);
    assert.equal(health.chatBaseUrl, chat.url);
    assert.equal(health.runtime?.aiProvider, "ollama");
    assert.equal(health.runtime?.aiAgentPort, chat.port);

    const advice = await requestAutoYouLegalAdvice({
      question: "Draft a short execution note for a vendor NDA using OpenSign.",
      timeoutMs: 2000,
    });
    assert.equal(advice.reachable, true);
    assert.equal(advice.baseUrl, chat.url);
    assert.equal(advice.model, "local-legal:test");
    assert.match(advice.response, /OpenSign/i);
    assert.doesNotMatch(advice.response, /Gemini|OpenAI|Anthropic|Claude/i);
    assert.equal(advice.sessionId, "autoyou-signtoross-legal-advice-probe");
    assert.equal(advice.agentName, "root_agent");
    assert.equal(chat.seen.length, 1);

    console.log("AutoYou SignToROSS legal advice smoke passed");
    console.log(`Admin base: ${admin.url}`);
    console.log(`Chat base: ${chat.url}`);
    console.log(
      "Verified: AutoYou admin discovery, Mike/AutoYou Ollama env alignment, /api/chat legal advice bridge, local-model metadata, and OpenSign-aware response.",
    );
  } finally {
    restoreEnv(envSnapshot);
    await closeServer(admin.server);
    await closeServer(chat.server);
  }
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exitCode = 1;
});
