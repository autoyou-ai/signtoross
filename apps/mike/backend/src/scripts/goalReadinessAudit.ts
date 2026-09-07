import "dotenv/config";
import { spawnSync } from "child_process";
import path from "path";
import { parseFirstJsonObject } from "./jsonOutput";

type RequirementStatus = "pass" | "blocked";

type Requirement = {
  id: string;
  status: RequirementStatus;
  evidence: string;
  next?: string;
};

type AuditReport = {
  ok: boolean;
  requirements: Requirement[];
  next_requirement: Requirement | null;
};

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

type OllamaPreflightReport = {
  ok: boolean;
  baseUrl?: string;
  model?: string;
  version?: string | null;
  modelInstalled?: boolean | null;
  cloudFallbackDisabled?: boolean;
  failures?: string[];
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

function truthy(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

const jsonOutput =
  process.argv.includes("--json") || truthy(process.env.GOAL_AUDIT_JSON ?? "");

function runNpmScript(
  script: string,
  args: string[] = [],
  options: {
    quiet?: boolean;
    strictEnv?: boolean;
    env?: Record<string, string>;
  } = {},
): { status: number | null; output: string } {
  const env = {
    ...process.env,
    ...(options.env ?? {}),
    ...(options.strictEnv
      ? {
          AUTOYOU_RUNTIME_REQUIRED: "true",
          AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED: "true",
          INTEGRATION_DOCTOR_JSON: "true",
          INTEGRATION_DOCTOR_STRICT: "true",
          PUBLIC_WEBHOOK_REQUIRED: "true",
          SIGNING_PROVIDER: process.env.SIGNING_PROVIDER || "opensign",
        }
      : {}),
  };

  const result = spawnSync(
    npmCommand,
    [...npmBaseArgs, "run", script, "--prefix", backendRoot, "--", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      stdio: options.quiet ? "pipe" : "inherit",
    },
  );

  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function parseDoctorJson(output: string): DoctorReport | null {
  return parseFirstJsonObject<DoctorReport>(output);
}

function parseOllamaPreflightJson(output: string): OllamaPreflightReport | null {
  return parseFirstJsonObject<OllamaPreflightReport>(output);
}

function gate(report: DoctorReport | null, name: string): DoctorGate | null {
  return report?.gates.find((candidate) => candidate.name === name) ?? null;
}

function blockedFromGate(
  id: string,
  current: DoctorGate | null,
  fallbackNext: string,
): Requirement {
  return {
    id,
    status: current?.status === "pass" ? "pass" : "blocked",
    evidence: current
      ? `[${current.status.toUpperCase()}] ${current.name}: ${current.detail}`
      : "Strict live preflight did not return this gate.",
    next: current?.status === "pass" ? undefined : (current?.next ?? fallbackNext),
  };
}

function printReport(report: AuditReport): void {
  console.log("\nMike objective readiness audit\n");
  for (const requirement of report.requirements) {
    const marker = requirement.status === "pass" ? "PASS" : "BLOCKED";
    console.log(`[${marker}] ${requirement.id}`);
    console.log(`  ${requirement.evidence}`);
    if (requirement.next) console.log(`  Next: ${requirement.next}`);
  }

  if (report.next_requirement) {
    console.log(`\nNext objective gate: ${report.next_requirement.id}`);
    if (report.next_requirement.next) console.log(report.next_requirement.next);
  } else {
    console.log("\nAll objective gates are proven.");
  }
}

function buildReport(args: {
  ollamaPreflightStatus: number | null;
  ollamaPreflight: OllamaPreflightReport | null;
  fallbackSmokeStatus: number | null;
  localLoopStatus: number | null;
  livePreflight: DoctorReport | null;
}): AuditReport {
  const requirements: Requirement[] = [
    {
      id: "local-ollama-legal-model-no-cloud-fallback",
      status:
        args.ollamaPreflightStatus === 0 &&
        args.ollamaPreflight?.ok === true &&
        args.ollamaPreflight.cloudFallbackDisabled === true
          ? "pass"
          : "blocked",
      evidence:
        args.ollamaPreflightStatus === 0 &&
        args.ollamaPreflight?.ok === true &&
        args.ollamaPreflight.cloudFallbackDisabled === true
          ? `Ollama legal preflight passed with cloud fallback disabled; base=${args.ollamaPreflight.baseUrl ?? "unknown"}; model=${args.ollamaPreflight.model ?? "unknown"}; installed=${String(args.ollamaPreflight.modelInstalled)}; version=${args.ollamaPreflight.version ?? "unknown"}.`
          : args.ollamaPreflight
            ? `Ollama legal preflight failed: ${(args.ollamaPreflight.failures ?? ["unknown_failure"]).join(", ")}`
            : `Ollama legal preflight exited with ${args.ollamaPreflightStatus ?? "unknown"} and did not return a parseable report.`,
      next:
        args.ollamaPreflightStatus === 0 &&
        args.ollamaPreflight?.ok === true &&
        args.ollamaPreflight.cloudFallbackDisabled === true
          ? undefined
          : "Start Ollama, pull/set OLLAMA_MODEL, and rerun integration:ollama-legal-preflight with cloud fallback disabled.",
    },
    {
      id: "local-ollama-cloud-fallback-boundary",
      status: args.fallbackSmokeStatus === 0 ? "pass" : "blocked",
      evidence:
        args.fallbackSmokeStatus === 0
          ? "integration:ollama-fallback-smoke passed: local-only mode did not call cloud fallback, Ollama fallback targets were rejected, and explicit cloud fallback selected Gemini only after Ollama failed before output."
          : `integration:ollama-fallback-smoke exited with ${args.fallbackSmokeStatus ?? "unknown"}.`,
      next:
        args.fallbackSmokeStatus === 0
          ? undefined
          : "Fix Ollama fallback routing before relying on cloud fallback during live testing.",
    },
    blockedFromGate(
      "cloud-fallback-configured",
      gate(args.livePreflight, "Cloud fallback"),
      "Set OLLAMA_CLOUD_FALLBACK=true and configure OLLAMA_FALLBACK_MODEL plus the matching instance or user API key.",
    ),
    {
      id: "local-ollama-signtoross-generated-document-signature-monitoring-loop",
      status: args.localLoopStatus === 0 ? "pass" : "blocked",
      evidence:
        args.localLoopStatus === 0
          ? "integration:full-local-loop passed: local Ollama legal output, AutoYou SignToROSS advice contract, chat-generated document signing, signed OpenSign webhook completion, signed-PDF import, signature watcher JSON, and public webhook fail-closed safety."
          : `integration:full-local-loop exited with ${args.localLoopStatus ?? "unknown"}.`,
      next:
        args.localLoopStatus === 0
          ? undefined
          : "Fix the first failing full-local-loop step before attempting live signing.",
    },
    blockedFromGate(
      "live-autoyou-runtime-reachable",
      gate(args.livePreflight, "AutoYou SignToROSS runtime alignment"),
      "Start AutoYou admin runtime or fix AUTOYOU_ADMIN_API_BASE.",
    ),
    blockedFromGate(
      "live-autoyou-signtoross-legal-advice-reachable",
      gate(args.livePreflight, "AutoYou SignToROSS legal advice bridge"),
      "Start AutoYou AI Agent chat API or fix AUTOYOU_CHAT_API_BASE/AUTOYOU_AI_API_BASE.",
    ),
    blockedFromGate(
      "live-opensign-api-token-reachable",
      gate(args.livePreflight, "OpenSign API reachability"),
      "Create or obtain an OpenSign API token before sending signature requests.",
    ),
    blockedFromGate(
      "live-opensign-webhook-secret-enforced",
      gate(args.livePreflight, "OpenSign webhook verification"),
      "Set OPENSIGN_WEBHOOK_SECRET to match the secret configured in OpenSign.",
    ),
    blockedFromGate(
      "live-public-webhook-route-configured",
      gate(args.livePreflight, "Public webhook routing"),
      "Set MIKE_PUBLIC_API_BASE_URL to the public HTTPS Mike API host and configure OpenSign to call /webhooks/signing/opensign.",
    ),
  ];
  const next = requirements.find((requirement) => requirement.status !== "pass") ?? null;
  return {
    ok: !next,
    requirements,
    next_requirement: next,
  };
}

function main(): void {
  if (!jsonOutput) {
    console.log("Running local Ollama legal-model preflight with cloud fallback disabled...");
  }
  const ollama = runNpmScript("integration:ollama-legal-preflight", [], {
    quiet: true,
    env: {
      OLLAMA_LEGAL_PREFLIGHT_JSON: "true",
    },
  });
  const ollamaReport = parseOllamaPreflightJson(ollama.output);

  if (!jsonOutput) {
    console.log("Running Ollama fallback boundary smoke...");
  }
  const fallback = runNpmScript("integration:ollama-fallback-smoke", [], {
    quiet: jsonOutput,
  });

  if (!jsonOutput) {
    console.log("Running full local acceptance loop before auditing live gates...");
  }
  const local = runNpmScript("integration:full-local-loop", [], {
    quiet: jsonOutput,
  });

  if (!jsonOutput) {
    console.log("\nRunning strict live preflight for external deployment gates...");
  }
  const live = runNpmScript("integration:doctor", ["--json", "--strict"], {
    quiet: true,
    strictEnv: true,
  });
  const liveReport = parseDoctorJson(live.output);
  const report = buildReport({
    ollamaPreflightStatus: ollama.status,
    ollamaPreflight: ollamaReport,
    fallbackSmokeStatus: fallback.status,
    localLoopStatus: local.status,
    livePreflight: liveReport,
  });

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  process.exitCode = report.ok ? 0 : 1;
}

main();
