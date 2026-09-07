import "dotenv/config";
import { strict as assert } from "assert";
import { spawn } from "child_process";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";
import { parseFirstJsonObject } from "./jsonOutput";

type EnvSnapshot = Record<string, string | undefined>;

type DoctorGate = {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  next?: string;
};

type DoctorReport = {
  ok: boolean;
  gates: DoctorGate[];
  next_gate: DoctorGate | null;
};

const backendRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(backendRoot, "..");
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath
  ? process.execPath
  : process.platform === "win32"
    ? "npm.cmd"
    : "npm";
const npmBaseArgs = npmExecPath ? [npmExecPath] : [];

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

async function startMockOllama() {
  return listen(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/version") {
      json(res, 200, { version: "mock-doctor-all-green" });
      return;
    }
    if (req.method === "GET" && req.url === "/api/tags") {
      json(res, 200, { models: [{ name: "local-legal:test" }] });
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const body = await readJson(req);
      assert.equal(body.model, "local-legal:test");
      json(res, 200, {
        message: {
          role: "assistant",
          content:
            "This Agreement may be executed electronically through OpenSign, and those electronic signatures will be valid when the parties consent.",
        },
      });
      return;
    }
    json(res, 404, { error: "not found" });
  });
}

async function startMockAutoYouChat() {
  return listen(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
      const body = await readJson(req);
      assert.equal(typeof body.message, "string");
      assert.match(String(body.message), /OpenSign/i);
      json(res, 200, {
        response:
          "The local SignToROSS model can advise that parties may sign through OpenSign when consent is documented and the final signed PDF is retained.",
        session_id: body.session_id ?? "autoyou-signtoross-legal-advice-probe",
        message_id: "mock-doctor-signtoross-message",
        agent_name: "root_agent",
        metadata: { ai_provider: "ollama", model: "local-legal:test" },
      });
      return;
    }
    json(res, 404, { error: "not found" });
  });
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
      json(res, 200, { ai_provider: "ollama" });
      return;
    }
    json(res, 404, { error: "not found" });
  });
}

async function startMockOpenSign() {
  return listen(async (req, res) => {
    if (req.headers["x-api-token"] !== "test-token") {
      json(res, 401, { error: "missing token" });
      return;
    }
    if (
      req.method === "GET" &&
      req.url === "/document/__mike_integration_probe__"
    ) {
      json(res, 404, { error: "probe document not found" });
      return;
    }
    json(res, 404, { error: "not found" });
  });
}

async function runDoctor(): Promise<DoctorReport> {
  const child = spawn(
    npmCommand,
    [
      ...npmBaseArgs,
      "run",
      "integration:doctor",
      "--prefix",
      backendRoot,
      "--",
      "--json",
      "--strict",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        INTEGRATION_DOCTOR_JSON: "true",
        INTEGRATION_DOCTOR_STRICT: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const output = `${stdout}\n${stderr}`;
  const report = parseFirstJsonObject<DoctorReport>(output);
  if (!report) {
    throw new Error(`Doctor did not return JSON:\n${output}`);
  }
  if (status !== 0) {
    throw new Error(`Doctor exited with ${status}:\n${output}`);
  }
  return report;
}

async function main(): Promise<void> {
  const envSnapshot = snapshotEnv([
    "AI_PROVIDER",
    "OLLAMA_ENABLED",
    "OLLAMA_API_BASE",
    "OLLAMA_BASE_URL",
    "OLLAMA_MODEL",
    "OLLAMA_CLOUD_FALLBACK",
    "AUTOYOU_ADMIN_API_BASE",
    "AUTOYOU_CHAT_API_BASE",
    "AUTOYOU_RUNTIME_REQUIRED",
    "AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED",
    "OPENSIGN_API_BASE_URL",
    "OPENSIGN_API_MODE",
    "OPENSIGN_API_TOKEN",
    "OPENSIGN_WEBHOOK_SECRET",
    "MIKE_PUBLIC_API_BASE_URL",
    "PUBLIC_WEBHOOK_REQUIRED",
  ]);
  const mockOllama = await startMockOllama();
  const mockAutoYouChat = await startMockAutoYouChat();
  const mockAutoYouAdmin = await startMockAutoYouAdmin(mockAutoYouChat.port);
  const mockOpenSign = await startMockOpenSign();

  try {
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_ENABLED = "true";
    process.env.OLLAMA_API_BASE = mockOllama.url;
    process.env.OLLAMA_BASE_URL = mockOllama.url;
    process.env.OLLAMA_MODEL = "local-legal:test";
    process.env.OLLAMA_CLOUD_FALLBACK = "false";
    process.env.AUTOYOU_ADMIN_API_BASE = mockAutoYouAdmin.url;
    process.env.AUTOYOU_CHAT_API_BASE = mockAutoYouChat.url;
    process.env.AUTOYOU_RUNTIME_REQUIRED = "true";
    process.env.AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED = "true";
    process.env.OPENSIGN_API_MODE = "token";
    process.env.OPENSIGN_API_BASE_URL = mockOpenSign.url;
    process.env.OPENSIGN_API_TOKEN = "test-token";
    process.env.OPENSIGN_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.MIKE_PUBLIC_API_BASE_URL = "https://mike.example.invalid";
    process.env.PUBLIC_WEBHOOK_REQUIRED = "true";

    const report = await runDoctor();
    assert.equal(report.ok, true);
    assert.equal(report.next_gate, null);
    const nonPass = report.gates.filter((gate) => gate.status !== "pass");
    assert.deepEqual(nonPass, []);

    console.log("Doctor all-green smoke passed");
    console.log(`Mock Ollama: ${mockOllama.url}`);
    console.log(`Mock AutoYou admin: ${mockAutoYouAdmin.url}`);
    console.log(`Mock AutoYou chat: ${mockAutoYouChat.url}`);
    console.log(`Mock OpenSign: ${mockOpenSign.url}`);
    console.log(
      "Verified: every integration doctor gate can pass with configured OpenSign, webhook HMAC, public webhook routing, AutoYou SignToROSS, local Ollama, storage, and persistence.",
    );
  } finally {
    restoreEnv(envSnapshot);
    await closeServer(mockOpenSign.server);
    await closeServer(mockAutoYouAdmin.server);
    await closeServer(mockAutoYouChat.server);
    await closeServer(mockOllama.server);
  }
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exitCode = 1;
});
