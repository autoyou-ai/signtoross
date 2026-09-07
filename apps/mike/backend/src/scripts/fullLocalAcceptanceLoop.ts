import "dotenv/config";
import { spawnSync } from "child_process";
import path from "path";
import { parseFirstJsonObject } from "./jsonOutput";

type Step = {
  name: string;
  script: string;
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

const backendRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(backendRoot, "..");
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath
  ? process.execPath
  : process.platform === "win32"
    ? "npm.cmd"
    : "npm";
const npmBaseArgs = npmExecPath ? [npmExecPath] : [];

const steps: Step[] = [
  {
    name: "Backend build",
    script: "build",
  },
  {
    name: "Local Ollama legal-model preflight",
    script: "integration:ollama-legal-preflight",
  },
  {
    name: "Ollama cloud fallback boundary",
    script: "integration:ollama-fallback-smoke",
  },
  {
    name: "AutoYou SignToROSS legal-advice contract",
    script: "integration:autoyou-signtoross-smoke",
  },
  {
    name: "Chat-generated document through signed OpenSign webhook",
    script: "integration:chat-generated-webhook-smoke",
  },
  {
    name: "Persisted signature watcher and signed-PDF import",
    script: "integration:persisted-smoke",
  },
  {
    name: "Public webhook fail-closed safety",
    script: "integration:webhook-public-rejection",
  },
];

function runScript(step: Step): boolean {
  console.log(`\n==> ${step.name}`);
  const result = spawnSync(
    npmCommand,
    [...npmBaseArgs, "run", step.script, "--prefix", backendRoot],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );

  if (result.error) {
    console.error(`Step failed to start: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`Step failed: ${step.name} exited with ${result.status}`);
    return false;
  }
  return true;
}

function runDoctorJson(): DoctorReport | null {
  const result = spawnSync(
    npmCommand,
    [
      ...npmBaseArgs,
      "run",
      "integration:doctor",
      "--prefix",
      backendRoot,
      "--",
      "--json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        INTEGRATION_DOCTOR_JSON: "true",
      },
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const parsed = parseFirstJsonObject<DoctorReport>(output);
  if (!parsed) {
    console.error("Doctor did not return JSON output.");
    console.error(output.trim());
    return null;
  }
  return parsed;
}

function printDoctorSummary(report: DoctorReport): void {
  console.log("\n==> Remaining live-readiness gates");
  for (const gate of report.gates) {
    if (gate.status === "pass") continue;
    const marker = gate.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${marker}] ${gate.name}`);
    console.log(`  ${gate.detail}`);
    if (gate.next) console.log(`  Next: ${gate.next}`);
  }

  if (report.next_gate) {
    console.log(`\nNext live gate: ${report.next_gate.name}`);
    if (report.next_gate.next) console.log(report.next_gate.next);
  } else {
    console.log(
      "\nNo live-readiness gaps remain. Continue with one controlled OpenSign live send and a Mike request watcher.",
    );
  }
}

async function main(): Promise<void> {
  console.log("Mike full local acceptance loop");
  console.log(
    "Proves local Ollama legal output, SignToROSS advice contract, generated document signing, webhook completion, signature monitoring, and public webhook safety.",
  );

  for (const step of steps) {
    if (!runScript(step)) {
      process.exitCode = 1;
      return;
    }
  }

  const report = runDoctorJson();
  if (!report) {
    process.exitCode = 1;
    return;
  }

  printDoctorSummary(report);
  console.log(
    "\nFull local acceptance loop passed. Live OpenSign credentials, public callback routing, and live AutoYou availability remain external deployment gates when listed above.",
  );
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exitCode = 1;
});
