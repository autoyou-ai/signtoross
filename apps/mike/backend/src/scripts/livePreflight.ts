import "dotenv/config";
import { spawnSync } from "child_process";
import path from "path";
import { parseFirstJsonObject } from "./jsonOutput";

type GateStatus = "pass" | "warn" | "fail";

type DoctorGate = {
  name: string;
  status: GateStatus;
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

function runDoctor(): { report: DoctorReport | null; output: string } {
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
      "--strict",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTOYOU_RUNTIME_REQUIRED: "true",
        AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED: "true",
        INTEGRATION_DOCTOR_JSON: "true",
        INTEGRATION_DOCTOR_STRICT: "true",
        PUBLIC_WEBHOOK_REQUIRED: "true",
        SIGNING_PROVIDER: process.env.SIGNING_PROVIDER || "opensign",
      },
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    report: parseFirstJsonObject<DoctorReport>(output),
    output,
  };
}

function printGate(gate: DoctorGate): void {
  const marker =
    gate.status === "pass" ? "PASS" : gate.status === "warn" ? "WARN" : "FAIL";
  console.log(`[${marker}] ${gate.name}`);
  console.log(`  ${gate.detail}`);
  if (gate.next) console.log(`  Next: ${gate.next}`);
}

function main(): void {
  console.log("Mike live preflight");
  console.log(
    "Enforced gates: PUBLIC_WEBHOOK_REQUIRED=true, AUTOYOU_RUNTIME_REQUIRED=true, AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED=true.",
  );
  console.log("No document is sent and no signature email is created.\n");

  const { report, output } = runDoctor();
  if (!report) {
    console.error("Live preflight could not parse the integration doctor output.");
    console.error(output.trim());
    process.exitCode = 1;
    return;
  }

  for (const gate of report.gates) printGate(gate);

  const failures = report.gates.filter((gate) => gate.status === "fail");
  const warnings = report.gates.filter((gate) => gate.status === "warn");
  if (failures.length || warnings.length) {
    const next = report.next_gate ?? failures[0] ?? warnings[0];
    if (next) {
      console.log(`\nNext live gate: ${next.name}`);
      if (next.next) console.log(next.next);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    "\nLive preflight passed. Continue with one controlled OpenSign live send, then watch the Mike request until signed-PDF import is available.",
  );
}

main();
