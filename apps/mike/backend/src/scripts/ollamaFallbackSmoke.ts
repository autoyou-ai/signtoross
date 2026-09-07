import "dotenv/config";
import { strict as assert } from "assert";
import { completeText } from "../lib/llm";

type EnvSnapshot = Record<string, string | undefined>;

const ENV_KEYS = [
  "AI_PROVIDER",
  "OLLAMA_ENABLED",
  "OLLAMA_BASE_URL",
  "OLLAMA_API_BASE",
  "OLLAMA_MODEL",
  "OLLAMA_CLOUD_FALLBACK",
  "OLLAMA_FALLBACK_MODEL",
  "GEMINI_API_KEY",
] as const;

function snapshotEnv(): EnvSnapshot {
  return Object.fromEntries(ENV_KEYS.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function captureFailure(): Promise<string> {
  try {
    await completeText({
      model: "ollama:default",
      user: "Say hello.",
      maxTokens: 8,
    });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("Expected Ollama completion to fail in fallback smoke.");
}

async function main(): Promise<void> {
  const envSnapshot = snapshotEnv();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  try {
    process.env.OLLAMA_ENABLED = "true";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
    process.env.OLLAMA_MODEL = "local-legal:test";
    delete process.env.OLLAMA_API_BASE;
    delete process.env.AI_PROVIDER;

    process.env.OLLAMA_CLOUD_FALLBACK = "false";
    let failure = await captureFailure();
    assert.doesNotMatch(failure, /Gemini|OpenAI|Anthropic|Claude|API key/i);

    process.env.OLLAMA_CLOUD_FALLBACK = "true";
    process.env.OLLAMA_FALLBACK_MODEL = "ollama:default";
    failure = await captureFailure();
    assert.doesNotMatch(failure, /Gemini|OpenAI|Anthropic|Claude|API key/i);

    delete process.env.GEMINI_API_KEY;
    process.env.OLLAMA_FALLBACK_MODEL = "gemini-3.1-flash-lite-preview";
    console.warn = (...args: unknown[]) => {
      warnings.push(
        args
          .map((value) =>
            typeof value === "string" ? value : JSON.stringify(value),
          )
          .join(" "),
      );
    };
    failure = await captureFailure();
    console.warn = originalWarn;
    assert.match(failure, /Gemini API key is not configured/i);
    assert.equal(
      warnings.some((warning) =>
        /Ollama completion failed; falling back/.test(warning),
      ),
      true,
    );

    console.log("Ollama fallback boundary smoke passed");
    console.log(
      "Verified: local-only mode does not use cloud fallback, Ollama fallback models are rejected as fallback targets, and explicit cloud fallback selects Gemini only after Ollama fails before output.",
    );
  } finally {
    console.warn = originalWarn;
    restoreEnv(envSnapshot);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
