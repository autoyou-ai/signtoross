import "dotenv/config";
import { spawnSync } from "child_process";
import path from "path";
import { parseFirstJsonObject } from "./jsonOutput";

type Step = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
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

const args = new Set(process.argv.slice(2));
const skipFrontend = args.has("--skip-frontend");
const skipSlow = args.has("--skip-slow");

function npmStep(name: string, script: string, cwd = repoRoot): Step {
  return {
    name,
    command: npmCommand,
    args: [...npmBaseArgs, "run", script, "--prefix", backendRoot],
    cwd,
  };
}

function frontendBuildStep(): Step {
  return {
    name: "Frontend build",
    command: npmCommand,
    args: [
      ...npmBaseArgs,
      "run",
      "build",
      "--prefix",
      path.join(repoRoot, "frontend"),
    ],
    cwd: repoRoot,
  };
}

function runStep(step: Step): boolean {
  console.log(`\n==> ${step.name}`);
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    stdio: "inherit",
    env: process.env,
  });
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
  console.log("\n==> Live readiness summary");
  for (const gate of report.gates) {
    const marker =
      gate.status === "pass"
        ? "PASS"
        : gate.status === "warn"
          ? "WARN"
          : "FAIL";
    console.log(`[${marker}] ${gate.name}`);
    console.log(`  ${gate.detail}`);
    if (gate.next) console.log(`  Next: ${gate.next}`);
  }

  if (report.next_gate) {
    console.log(`\nNext gate: ${report.next_gate.name}`);
    if (report.next_gate.next) console.log(report.next_gate.next);
  } else {
    console.log(
      "\nAll readiness gates passed. Continue with the app UI live loop: generate, send, sign, webhook, and download the signed PDF.",
    );
  }
}

async function main(): Promise<void> {
  const steps: Step[] = [
    npmStep("Backend build", "build"),
    ...(skipFrontend ? [] : [frontendBuildStep()]),
    npmStep("Adapter smoke", "smoke:adapters"),
    npmStep(
      "Ollama legal model preflight",
      "integration:ollama-legal-preflight",
    ),
    npmStep(
      "Ollama cloud fallback boundary smoke",
      "integration:ollama-fallback-smoke",
    ),
    npmStep("AutoYou SignToROSS contract smoke", "integration:autoyou-signtoross-smoke"),
    npmStep(
      "Doctor all-green mock smoke",
      "integration:doctor-all-green-smoke",
    ),
    npmStep("API signing smoke", "integration:api-smoke"),
    npmStep(
      "Persisted signature watcher smoke",
      "integration:persisted-smoke",
    ),
    npmStep(
      "Generated document signing smoke",
      "integration:generated-signing-smoke",
    ),
    npmStep(
      "Chat-generated signing webhook smoke",
      "integration:chat-generated-webhook-smoke",
    ),
    npmStep(
      "Public webhook rejection smoke",
      "integration:webhook-public-rejection",
    ),
    ...(skipSlow
      ? []
      : [
          npmStep(
            "Chat-generated provider-sync smoke",
            "integration:chat-generated-signing-smoke",
          ),
        ]),
  ];

  console.log("Mike positive integration loop");
  console.log(`Backend: ${backendRoot}`);
  if (skipFrontend) console.log("Frontend build skipped by --skip-frontend.");
  if (skipSlow)
    console.log("Slow duplicate provider-sync smoke skipped by --skip-slow.");

  for (const step of steps) {
    if (!runStep(step)) {
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

  const hardLocalFailure = report.gates.some(
    (gate) =>
      gate.status === "fail" &&
      !["OpenSign API reachability"].includes(gate.name),
  );
  process.exitCode = hardLocalFailure ? 1 : 0;
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exitCode = 1;
});
