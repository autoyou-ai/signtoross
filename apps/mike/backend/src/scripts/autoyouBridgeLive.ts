import "dotenv/config";
import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import net from "node:net";
import type { AddressInfo } from "node:net";
import {
  checkAutoYouRuntime,
  requestAutoYouLegalAdvice,
} from "../lib/autoyouRuntime";

function timeout(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  assert(Number.isFinite(value) && value > 0, `${name} must be a positive number`);
  return value;
}

async function closedLoopbackUrl(): Promise<string> {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${port}`;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const testId = `MIKE-BRIDGE-${crypto.randomUUID()}`;
  assert.equal(
    process.env.OLLAMA_CLOUD_FALLBACK?.trim().toLowerCase(),
    "false",
    "Set OLLAMA_CLOUD_FALLBACK=false for local-only verification",
  );
  const health = await checkAutoYouRuntime(
    timeout("AUTOYOU_RUNTIME_TIMEOUT_MS", 5000),
  );
  assert(health.configured, "Configure the AutoYou admin and chat endpoints first");
  assert(health.reachable, `AutoYou admin is unreachable: ${health.error ?? "unknown error"}`);
  assert(health.envAligned, health.warnings.join(" "));
  assert.equal(health.runtime?.aiProvider, "ollama", "AutoYou must report the Ollama provider");

  const advice = await requestAutoYouLegalAdvice({
    question:
      "This is a software integration fixture. In two short sentences, write a demonstration-only NDA execution note saying parties may use OpenSign electronic signatures after agreeing to electronic signing. " +
      `Include the exact marker ${testId}. Use ASCII punctuation. Return text only; do not browse, send, sign, or call another service.`,
    sessionId: testId,
    userId: "mike-bridge-verification",
    timeoutMs: timeout("AUTOYOU_SIGNTOROSS_ADVICE_TIMEOUT_MS", 180000),
  });
  assert(advice.reachable && !advice.error, advice.error || "AutoYou chat failed");
  assert.match(advice.response, /OpenSign/i, "Reply must address the requested signing workflow");
  assert(advice.response.includes(testId), "Reply must contain this run's fresh marker");
  assert.equal(advice.sessionId, testId, "AutoYou must preserve the requested session");
  assert(advice.agentName, "AutoYou must identify the responding agent");

  // Exercise the same bridge with an unavailable endpoint while Ollama stays
  // reachable. The bridge must fail instead of silently bypassing AutoYou.
  const previousChatBase = process.env.AUTOYOU_CHAT_API_BASE;
  let unavailable;
  try {
    process.env.AUTOYOU_CHAT_API_BASE = await closedLoopbackUrl();
    unavailable = await requestAutoYouLegalAdvice({
      question: "Unavailable endpoint check; no reply should be generated.",
      timeoutMs: 1500,
    });
  } finally {
    if (previousChatBase === undefined) delete process.env.AUTOYOU_CHAT_API_BASE;
    else process.env.AUTOYOU_CHAT_API_BASE = previousChatBase;
  }
  assert.equal(unavailable.reachable, false, "Unavailable AutoYou must fail");
  assert.equal(unavailable.response, "", "Unavailable AutoYou must not produce a fallback reply");

  const report = {
    passed: true,
    startedAt,
    completedAt: new Date().toISOString(),
    testId,
    runtime: health.runtime,
    configuredModel: health.mike.ollamaModel,
    agentName: advice.agentName,
    sessionId: advice.sessionId,
    response: advice.response,
    checks: {
      adminReachable: true,
      providerAligned: true,
      freshChatReply: true,
      sessionPreserved: true,
      unavailableBridgeRejected: true,
      cloudFallbackDisabled: true,
    },
  };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`PASS: Mike -> AutoYou -> Ollama (${report.configuredModel})`);
    console.log(`Session: ${testId}; agent: ${advice.agentName}`);
    console.log("Admin/provider alignment, fresh reply, and unavailable-bridge rejection passed.");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ passed: false, error: message }));
  else console.error(`FAIL: ${message}`);
  process.exitCode = 1;
});
