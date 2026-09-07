import "dotenv/config";
import {
  checkOllamaHealth,
  completeText,
  resolveOllamaModel,
} from "../lib/llm";

type CaseResult = {
  name: string;
  ok: boolean;
  answer: string;
  failures: string[];
};

type ProbeCase = {
  name: string;
  user: string;
  required: RegExp[];
};

const args = new Set(process.argv.slice(2));

function envTruthy(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(
    process.env[name]?.trim().toLowerCase() ?? "",
  );
}

const jsonOutput =
  args.has("--json") ||
  envTruthy("OLLAMA_LEGAL_PREFLIGHT_JSON") ||
  envTruthy("OLLAMA_PREFLIGHT_JSON");
const BANNED = /docusign|adobe\s*sign|notarize|gemini|openai|anthropic|claude/i;
const CASES: ProbeCase[] = [
  {
    name: "opensign-signature-clause",
    user:
      "Draft one concise vendor NDA electronic-signature clause. It must use OpenSign as the only signing service.",
    required: [/opensign/i, /electronic/i, /sign/i],
  },
  {
    name: "opensign-monitoring-note",
    user:
      "In two short sentences, explain how Mike should monitor an OpenSign request after a generated agreement is sent for signature. Use the words signed or completed, and mention the signed PDF or webhook import.",
    required: [/opensign/i, /sign/i, /completed|completion|signed|pdf|webhook/i],
  },
];

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function display(value: string): string {
  return value.length > 360 ? `${value.slice(0, 357)}...` : value;
}

async function runCase(probe: ProbeCase): Promise<CaseResult> {
  const answer = compact(
    await completeText({
      model: "ollama:default",
      systemPrompt:
        "You are Mike's local legal-model preflight. Keep answers brief, practical, and specific to Mike using OpenSign. Do not mention cloud model providers or alternative signing services.",
      user: probe.user,
      maxTokens: 160,
    }),
  );
  const failures: string[] = [];
  if (!answer) failures.push("empty_answer");
  for (const required of probe.required) {
    if (!required.test(answer)) failures.push(`missing:${required.source}`);
  }
  if (BANNED.test(answer)) failures.push("banned_provider_or_signing_service");
  return {
    name: probe.name,
    ok: failures.length === 0,
    answer,
    failures,
  };
}

async function main(): Promise<void> {
  const previousFallback = process.env.OLLAMA_CLOUD_FALLBACK;
  process.env.OLLAMA_CLOUD_FALLBACK = "false";

  try {
    const model = resolveOllamaModel("ollama:default");
    const health = await checkOllamaHealth("ollama:default", 5000);
    const results: CaseResult[] = [];
    if (health.configured && health.reachable && health.modelInstalled !== false) {
      for (const probe of CASES) results.push(await runCase(probe));
    }

    const failures: string[] = [];
    if (!health.configured) failures.push("ollama_not_configured");
    if (!health.reachable) failures.push("ollama_not_reachable");
    if (health.modelInstalled === false) failures.push("model_not_installed");
    for (const result of results) {
      for (const failure of result.failures) {
        failures.push(`${result.name}:${failure}`);
      }
    }

    const report = {
      ok: failures.length === 0,
      baseUrl: health.baseUrl,
      model,
      version: health.version ?? null,
      modelInstalled: health.modelInstalled,
      cloudFallbackDisabled: true,
      cases: results,
      failures,
    };

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("Ollama legal model preflight");
      console.log(`Base URL: ${report.baseUrl}`);
      console.log(`Model: ${report.model}`);
      console.log(`Version: ${report.version ?? "unknown"}`);
      console.log("Cloud fallback: disabled for this preflight\n");
      for (const result of results) {
        console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.name}`);
        console.log(`  ${result.answer ? display(result.answer) : "(empty)"}`);
        if (result.failures.length) {
          console.log(`  Failures: ${result.failures.join(", ")}`);
        }
      }
      if (failures.length) {
        console.log(`\nNext gate: ${failures[0]}`);
      } else {
        console.log(
          "\nLocal Ollama legal model preflight passed. The selected model answered OpenSign-aware legal prompts without cloud fallback.",
        );
      }
    }

    process.exitCode = report.ok ? 0 : 1;
  } finally {
    if (previousFallback === undefined) {
      delete process.env.OLLAMA_CLOUD_FALLBACK;
    } else {
      process.env.OLLAMA_CLOUD_FALLBACK = previousFallback;
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
