import "dotenv/config";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import {
  checkOllamaHealth,
  completeText,
  providerForModel,
  type Provider,
} from "../lib/llm";
import { getSigningProvider } from "../lib/signing";
import {
  checkAutoYouRuntime,
  requestAutoYouLegalAdvice,
} from "../lib/autoyouRuntime";
import { openSignApiMode } from "../lib/signing/opensign";
import { deleteFile, getSignedUrl, uploadFile } from "../lib/storage";

type GateStatus = "pass" | "warn" | "fail";

type Gate = {
  name: string;
  status: GateStatus;
  detail: string;
  next?: string;
};

const gates: Gate[] = [];
const args = new Set(process.argv.slice(2));

function truthy(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

const jsonOutput = args.has("--json") || truthy(process.env.INTEGRATION_DOCTOR_JSON ?? "");
const strict = args.has("--strict") || truthy(process.env.INTEGRATION_DOCTOR_STRICT ?? "");

function addGate(gate: Gate): void {
  gates.push(gate);
}

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function disabled(value: string): boolean {
  return ["false", "0", "no"].includes(value.trim().toLowerCase());
}

function signToRossAdviceRequired(): boolean {
  return truthy(env("AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED"));
}

function signToRossAdviceTimeoutMs(): number {
  return Number.parseInt(
    env("AUTOYOU_SIGNTOROSS_ADVICE_TIMEOUT_MS") || "30000",
    10,
  );
}

function missingEnv(names: string[]): string[] {
  return names.filter((name) => !env(name));
}

function providerEnvKey(provider: Provider): string | null {
  if (provider === "gemini") return "GEMINI_API_KEY";
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "claude") return "ANTHROPIC_API_KEY";
  return null;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function detectLocalModelDrift(value: string): string | null {
  const normalized = value.toLowerCase();
  const checks: Array<[RegExp, string]> = [
    [/ollama model .*not (installed|available|configured|reachable)/, "Ollama model unavailable"],
    [/local (ollama )?model .*not (installed|available|configured|reachable)/, "local model unavailable"],
    [/not (have|has) access to .*ollama/, "no Ollama access"],
    [/using my internal capabilities|use my internal capabilities/, "internal capabilities fallback"],
    [/internal capabilities to ensure/, "internal capabilities fallback"],
    [/gemini|openai|anthropic|claude/, "cloud provider reference"],
  ];
  for (const [pattern, reason] of checks) {
    if (pattern.test(normalized)) return reason;
  }
  return null;
}

function publicMikeApiBaseUrl(): string {
  return (
    env("MIKE_PUBLIC_API_BASE_URL") ||
    env("PUBLIC_API_BASE_URL") ||
    env("BACKEND_PUBLIC_URL") ||
    env("API_PUBLIC_URL")
  ).replace(/\/+$/, "");
}

function isLocalUrl(value: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(value);
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkGeneratedDocx(): Promise<void> {
  try {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              heading: HeadingLevel.TITLE,
              children: [
                new TextRun({
                  text: "MIKE INTEGRATION PROBE AGREEMENT",
                  bold: true,
                }),
              ],
            }),
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [new TextRun("Purpose")],
            }),
            new Paragraph({
              children: [
                new TextRun(
                  "This local probe confirms that the backend can produce a valid DOCX package before the persisted chat document flow is tested.",
                ),
              ],
            }),
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [new TextRun("Signature Page")],
            }),
            new Paragraph({
              children: [new TextRun("By: ______________________________")],
            }),
            new Paragraph({
              children: [new TextRun("Date: ____________________________")],
            }),
          ],
        },
      ],
    });
    const bytes = await Packer.toBuffer(doc);
    const zip = await JSZip.loadAsync(bytes);
    const requiredParts = [
      "[Content_Types].xml",
      "word/document.xml",
      "word/_rels/document.xml.rels",
    ];
    const missing = requiredParts.filter((part) => !zip.file(part));
    if (missing.length) {
      addGate({
        name: "Document generation primitive",
        status: "fail",
        detail: `Generated DOCX was missing: ${missing.join(", ")}`,
        next: "Fix DOCX packaging before testing persisted document generation.",
      });
      return;
    }

    const artifactDir = path.join(os.tmpdir(), "mike-integration-doctor");
    await fs.mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, "integration-probe.docx");
    await fs.writeFile(artifactPath, bytes);
    addGate({
      name: "Document generation primitive",
      status: "pass",
      detail: `Created and validated a DOCX package at ${artifactPath}.`,
    });
  } catch (err) {
    addGate({
      name: "Document generation primitive",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      next: "Fix local DOCX generation dependencies before testing chat-generated documents.",
    });
  }
}

async function checkPersistenceConfig(): Promise<void> {
  const missing = missingEnv([
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "R2_ENDPOINT_URL",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ]);
  if (missing.length) {
    addGate({
      name: "Persistence configuration",
      status: "fail",
      detail: `Missing env vars: ${missing.join(", ")}`,
      next: "Configure Supabase and S3-compatible storage before testing persisted generated documents or signed-PDF imports.",
    });
    return;
  }
  addGate({
    name: "Persistence configuration",
    status: "pass",
    detail: "Supabase and S3-compatible storage env vars are present.",
  });
}

async function probeSupabaseTable(table: string): Promise<void> {
  const base = env("SUPABASE_URL").replace(/\/+$/, "");
  const key = env("SUPABASE_SECRET_KEY");
  const url = `${base}/rest/v1/${table}?select=id&limit=1`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          apikey: key,
          authorization: `Bearer ${key}`,
        },
      },
      Number.parseInt(env("SUPABASE_HEALTH_TIMEOUT_MS") || "8000", 10),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${table}: could not reach ${base}/rest/v1 (${message})`);
  }
  if (response.ok) return;

  const body = await response.text().catch(() => "");
  throw new Error(
    `${table}: HTTP ${response.status}${
      body ? ` - ${truncate(body.replace(/\s+/g, " "), 180)}` : ""
    }`,
  );
}

async function checkPersistenceReachability(): Promise<void> {
  const missing = missingEnv(["SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
  if (missing.length) return;

  const tables = [
    "documents",
    "document_versions",
    "signature_requests",
    "signature_recipients",
    "signature_events",
  ];
  try {
    for (const table of tables) {
      await probeSupabaseTable(table);
    }
    addGate({
      name: "Persistence reachability and schema",
      status: "pass",
      detail: `Supabase REST is reachable and required document/signature tables exist: ${tables.join(", ")}.`,
    });
  } catch (err) {
    addGate({
      name: "Persistence reachability and schema",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      next: "Fix Supabase network access/service-role key and apply the Mike schema/migrations before testing document generation or signature monitoring.",
    });
  }
}

async function checkStorageReadiness(): Promise<void> {
  const missing = missingEnv([
    "R2_ENDPOINT_URL",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ]);
  if (missing.length) return;

  const key = `_integration/doctor-${crypto.randomUUID()}.txt`;
  try {
    await uploadFile(
      key,
      toArrayBuffer(Buffer.from("mike storage readiness probe\n", "utf8")),
      "text/plain",
    );
    const signedUrl = await getSignedUrl(key, 60, "mike-storage-probe.txt");
    if (!signedUrl) {
      addGate({
        name: "Storage write and signed URL",
        status: "fail",
        detail:
          "Probe object uploaded, but a signed download URL could not be generated.",
        next: "Check R2/S3 signing credentials and endpoint compatibility before testing generated documents or signed-PDF imports.",
      });
      return;
    }
    addGate({
      name: "Storage write and signed URL",
      status: "pass",
      detail: `Uploaded and signed a temporary probe object in bucket ${env("R2_BUCKET_NAME") || "mike"}.`,
    });
  } catch (err) {
    addGate({
      name: "Storage write and signed URL",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      next: "Create/configure the R2/S3 bucket and credentials before testing document generation or signed-PDF imports.",
    });
  } finally {
    await deleteFile(key).catch(() => undefined);
  }
}

async function checkOllama(): Promise<void> {
  const health = await checkOllamaHealth(
    "ollama:default",
    Number.parseInt(env("OLLAMA_HEALTH_TIMEOUT_MS") || "2500", 10),
  );
  if (!health.configured) {
    addGate({
      name: "Ollama local model health",
      status: "fail",
      detail: health.error ?? "Ollama is not enabled.",
      next: "Set AI_PROVIDER=ollama or OLLAMA_ENABLED=true, set OLLAMA_API_BASE, pull OLLAMA_MODEL, then restart the backend.",
    });
    return;
  }
  if (!health.reachable) {
    addGate({
      name: "Ollama local model health",
      status: "fail",
      detail: health.error ?? `Could not reach ${health.baseUrl}.`,
      next: "Start Ollama on the configured host or fix OLLAMA_API_BASE/OLLAMA_BASE_URL.",
    });
    return;
  }
  if (health.modelInstalled === false) {
    addGate({
      name: "Ollama local model health",
      status: "fail",
      detail: `${health.model} is not installed on ${health.baseUrl}.`,
      next: `Run: ollama pull ${health.model}`,
    });
    return;
  }
  addGate({
    name: "Ollama local model health",
    status: health.modelInstalled === null ? "warn" : "pass",
    detail: `Ollama responded at ${health.baseUrl}; model=${health.model}; version=${health.version ?? "unknown"}.`,
    next:
      health.modelInstalled === null
        ? "The model list could not confirm installation; run a local advice smoke before app testing."
        : undefined,
  });
}

async function checkLocalLegalAdvice(): Promise<void> {
  const previousFallback = process.env.OLLAMA_CLOUD_FALLBACK;
  process.env.OLLAMA_CLOUD_FALLBACK = "false";
  try {
    const answer = await completeText({
      model: "ollama:default",
      systemPrompt:
        "You are Mike's local legal drafting integration probe. Keep the answer under 40 words. Do not mention cloud APIs, DocuSign, Notarize, or any signing service except OpenSign.",
      user: "Draft one neutral NDA signature clause saying the parties may sign electronically through OpenSign.",
      maxTokens: 96,
    });
    const normalized = answer.trim().replace(/\s+/g, " ");
    if (!normalized) {
      addGate({
        name: "Local legal advice smoke",
        status: "fail",
        detail: "Ollama returned an empty response.",
        next: "Check the selected Ollama model and retry with OLLAMA_CLOUD_FALLBACK=false.",
      });
      return;
    }
    if (
      !/opensign/i.test(normalized) ||
      /docusign|notarize|gemini|openai/i.test(normalized)
    ) {
      addGate({
        name: "Local legal advice smoke",
        status: "fail",
        detail: normalized.slice(0, 240),
        next: "Tune the local model/prompt so legal drafting stays aligned to the Mike/OpenSign workflow without cloud-signing service drift.",
      });
      return;
    }
    addGate({
      name: "Local legal advice smoke",
      status: "pass",
      detail: normalized.slice(0, 240),
    });
  } catch (err) {
    addGate({
      name: "Local legal advice smoke",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      next: "Fix the Ollama health gate first; this gate intentionally disables cloud fallback.",
    });
  } finally {
    if (previousFallback === undefined) {
      delete process.env.OLLAMA_CLOUD_FALLBACK;
    } else {
      process.env.OLLAMA_CLOUD_FALLBACK = previousFallback;
    }
  }
}

async function checkAutoYouRuntimeAlignment(): Promise<void> {
  const health = await checkAutoYouRuntime(
    Number.parseInt(env("AUTOYOU_RUNTIME_TIMEOUT_MS") || "1500", 10),
  );
  if (!health.envAligned) {
    addGate({
      name: "AutoYou SignToROSS runtime alignment",
      status: "fail",
      detail: health.warnings.join(" "),
      next: "Set AI_PROVIDER=ollama, OLLAMA_API_BASE, and OLLAMA_MODEL so Mike and AutoYou share the same local model contract.",
    });
    return;
  }
  if (!health.reachable) {
    addGate({
      name: "AutoYou SignToROSS runtime alignment",
      status: health.required ? "fail" : "warn",
      detail: `Mike env is aligned, but AutoYou admin runtime was not reachable at ${health.baseUrl}: ${health.error ?? "not reachable"}`,
      next: health.required
        ? "Start the AutoYou admin runtime or fix AUTOYOU_ADMIN_API_BASE."
        : "Start AutoYou when you want to prove full SignToROSS/runtime reachability, or set AUTOYOU_RUNTIME_REQUIRED=true to make this a hard gate.",
    });
    return;
  }
  addGate({
    name: "AutoYou SignToROSS runtime alignment",
    status: health.warnings.length ? "warn" : "pass",
    detail: `AutoYou admin runtime is reachable at ${health.baseUrl}; chat API=${health.chatBaseUrl}; ai_provider=${health.runtime?.aiProvider ?? "unknown"}; Mike model=${health.mike.ollamaModel}.`,
    next: health.warnings.length ? health.warnings.join(" ") : undefined,
  });
}

async function checkAutoYouLegalAdviceBridge(): Promise<void> {
  const required =
    truthy(env("AUTOYOU_RUNTIME_REQUIRED")) ||
    signToRossAdviceRequired();
  const probe = await requestAutoYouLegalAdvice({
    question:
      "Draft one neutral vendor NDA execution note saying electronic signatures through OpenSign are acceptable when the parties consent.",
    timeoutMs: signToRossAdviceTimeoutMs(),
  });

  if (!probe.reachable) {
    addGate({
      name: "AutoYou SignToROSS legal advice bridge",
      status: required ? "fail" : "warn",
      detail: `AutoYou chat API was not reachable at ${probe.baseUrl}: ${probe.error ?? "not reachable"}`,
      next: required
        ? "Start the AutoYou AI Agent server or fix AUTOYOU_CHAT_API_BASE/AUTOYOU_AI_API_BASE."
        : "Start AutoYou when you want to prove SignToROSS legal advice generation, or set AUTOYOU_SIGNTOROSS_ADVICE_REQUIRED=true to make this a hard gate.",
    });
    return;
  }

  const normalized = probe.response.trim().replace(/\s+/g, " ");
  const driftReason = detectLocalModelDrift(normalized);
  if (
    !normalized ||
    !/opensign/i.test(normalized) ||
    driftReason
  ) {
    addGate({
      name: "AutoYou SignToROSS legal advice bridge",
      status: "fail",
      detail: `${
        driftReason ? `${driftReason}: ` : ""
      }${normalized.slice(0, 240) || (probe.error ?? "Empty response.")}`,
      next: "Tune the AutoYou SignToROSS prompt/model so the legal advice stays local-model aligned and OpenSign-aware, without fallback/internal-capability wording.",
    });
    return;
  }

  addGate({
    name: "AutoYou SignToROSS legal advice bridge",
    status: "pass",
    detail: `${probe.baseUrl} answered via ${probe.agentName ?? "unknown agent"} using ${probe.model}: ${normalized.slice(0, 220)}`,
  });
}

async function checkCloudFallback(): Promise<void> {
  if (disabled(env("OLLAMA_CLOUD_FALLBACK"))) {
    addGate({
      name: "Cloud fallback",
      status: "pass",
      detail: "OLLAMA_CLOUD_FALLBACK is disabled.",
    });
    return;
  }

  const fallbackModel =
    env("OLLAMA_FALLBACK_MODEL") || "gemini-3-flash-preview";
  let provider: Provider;
  try {
    provider = providerForModel(fallbackModel);
  } catch (err) {
    addGate({
      name: "Cloud fallback",
      status: "fail",
      detail: `Invalid OLLAMA_FALLBACK_MODEL=${fallbackModel}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      next: "Set OLLAMA_FALLBACK_MODEL to a non-Ollama cloud model.",
    });
    return;
  }

  if (provider === "ollama") {
    addGate({
      name: "Cloud fallback",
      status: "fail",
      detail: `OLLAMA_FALLBACK_MODEL=${fallbackModel} resolves back to Ollama.`,
      next: "Set OLLAMA_FALLBACK_MODEL to Gemini, OpenAI, or Anthropic.",
    });
    return;
  }

  const keyName = providerEnvKey(provider);
  if (keyName && env(keyName)) {
    addGate({
      name: "Cloud fallback",
      status: "pass",
      detail: `${fallbackModel} can use instance env ${keyName}.`,
    });
    return;
  }

  addGate({
    name: "Cloud fallback",
    status: "warn",
    detail: `${fallbackModel} is configured, but no instance env key is present for ${provider}. Per-user keys can still satisfy this after sign-in.`,
    next: `Add ${keyName ?? "the provider API key"} to backend env or confirm per-user API keys in Account > Models.`,
  });
}

async function checkOpenSign(): Promise<void> {
  const configuredProvider = env("SIGNING_PROVIDER") || "opensign";
  if (configuredProvider.toLowerCase() !== "opensign") {
    addGate({
      name: "OpenSign provider selection",
      status: "fail",
      detail: `SIGNING_PROVIDER=${configuredProvider}`,
      next: "Set SIGNING_PROVIDER=opensign.",
    });
    return;
  }

  if (openSignApiMode() === "selfhost") {
    const missing = missingEnv([
      "OPENSIGN_PARSE_MASTER_KEY",
      "OPENSIGN_ADMIN_EMAIL",
      "OPENSIGN_ADMIN_PASSWORD",
    ]);
    if (missing.length) {
      addGate({
        name: "OpenSign self-hosted Parse reachability",
        status: "fail",
        detail: `Missing env vars: ${missing.join(", ")}`,
        next: "Set OPENSIGN_API_MODE=selfhost and configure the local OpenSign Parse master key/admin credentials.",
      });
      return;
    }

    const base = (
      env("OPENSIGN_PARSE_BASE_URL") ||
      env("OPENSIGN_SELFHOST_API_BASE_URL") ||
      "http://127.0.0.1:3051/api/app"
    ).replace(/\/+$/, "");
    const appId = env("OPENSIGN_PARSE_APP_ID") || "opensign";
    const publicUrl =
      env("OPENSIGN_PUBLIC_URL") ||
      env("OPENSIGN_SELFHOST_PUBLIC_URL") ||
      "http://127.0.0.1:3051";
    let hostHeader = env("OPENSIGN_PARSE_HOST_HEADER");
    if (!hostHeader) {
      try {
        hostHeader = new URL(publicUrl).host;
      } catch {
        hostHeader = "";
      }
    }
    const baseHeaders: Record<string, string> = {
      "X-Parse-Application-Id": appId,
      ...(hostHeader ? { Host: hostHeader } : {}),
    };

    try {
      const loginResponse = await fetchWithTimeout(
        `${base}/login`,
        {
          method: "POST",
          headers: {
            ...baseHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: env("OPENSIGN_ADMIN_EMAIL"),
            password: env("OPENSIGN_ADMIN_PASSWORD"),
          }),
        },
        Number.parseInt(env("OPENSIGN_HEALTH_TIMEOUT_MS") || "8000", 10),
      );
      if (!loginResponse.ok) {
        addGate({
          name: "OpenSign self-hosted Parse reachability",
          status: "fail",
          detail: `OpenSign Parse login answered HTTP ${loginResponse.status}.`,
          next: "Check OPENSIGN_ADMIN_EMAIL, OPENSIGN_ADMIN_PASSWORD, and the local OpenSign Docker stack.",
        });
        return;
      }
      const login = (await loginResponse.json().catch(() => ({}))) as {
        objectId?: string;
      };
      if (!login.objectId) {
        addGate({
          name: "OpenSign self-hosted Parse reachability",
          status: "fail",
          detail: "OpenSign Parse login did not return an admin user id.",
          next: "Recreate or repair the OpenSign local admin account.",
        });
        return;
      }

      const where = encodeURIComponent(
        JSON.stringify({
          UserId: {
            __type: "Pointer",
            className: "_User",
            objectId: login.objectId,
          },
        }),
      );
      const profileResponse = await fetchWithTimeout(
        `${base}/classes/contracts_Users?where=${where}&limit=1`,
        {
          headers: {
            ...baseHeaders,
            "X-Parse-Master-Key": env("OPENSIGN_PARSE_MASTER_KEY"),
          },
        },
        Number.parseInt(env("OPENSIGN_HEALTH_TIMEOUT_MS") || "8000", 10),
      );
      if (!profileResponse.ok) {
        addGate({
          name: "OpenSign self-hosted Parse reachability",
          status: "fail",
          detail: `OpenSign admin profile lookup answered HTTP ${profileResponse.status}.`,
          next: "Check OPENSIGN_PARSE_MASTER_KEY and the OpenSign Mongo data.",
        });
        return;
      }
      const profile = (await profileResponse.json().catch(() => ({}))) as {
        results?: unknown[];
      };
      if (!profile.results?.length) {
        addGate({
          name: "OpenSign self-hosted Parse reachability",
          status: "fail",
          detail: "OpenSign admin Parse profile was not found.",
          next: "Complete first-run OpenSign admin setup before sending signature requests.",
        });
        return;
      }
      addGate({
        name: "OpenSign self-hosted Parse reachability",
        status: "pass",
        detail: `OpenSign self-hosted Parse API is reachable at ${base}; public signing URLs use ${publicUrl}.`,
      });
      const emailConfigured = truthy(env("OPENSIGN_SELFHOST_EMAIL_CONFIGURED"));
      const emailRequired = truthy(env("OPENSIGN_SELFHOST_REQUIRE_EMAIL"));
      if (emailConfigured || emailRequired) {
        addGate({
          name: "OpenSign self-hosted email delivery",
          status: emailConfigured ? "pass" : "fail",
          detail: emailConfigured
            ? "OpenSign self-hosted SMTP/Mailgun configuration is marked ready for live email verification."
            : "OpenSign self-hosted email delivery is required, but SMTP/Mailgun configuration has not been marked ready.",
          next: emailConfigured
            ? undefined
            : "Create the Gmail app password or configure Mailgun, run scripts/configure-opensign-gmail.ps1 -Restart, then verify with LIVE_SIGNING_REQUIRE_EMAIL=true.",
        });
      }
    } catch (err) {
      addGate({
        name: "OpenSign self-hosted Parse reachability",
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        next: "Start OpenSign or fix OPENSIGN_PARSE_BASE_URL/network routing.",
      });
    }
    return;
  }

  const token = env("OPENSIGN_API_TOKEN");
  if (!token) {
    addGate({
      name: "OpenSign API reachability",
      status: "fail",
      detail: "OPENSIGN_API_TOKEN is not set.",
      next: "Create or obtain an OpenSign sandbox/live/self-hosted API token before sending signature requests.",
    });
    return;
  }

  const base = (
    env("OPENSIGN_API_BASE_URL") || "https://sandbox.opensignlabs.com/api/v1.2"
  ).replace(/\/+$/, "");
  try {
    const response = await fetchWithTimeout(
      `${base}/document/__mike_integration_probe__`,
      { headers: { "x-api-token": token } },
      Number.parseInt(env("OPENSIGN_HEALTH_TIMEOUT_MS") || "8000", 10),
    );
    if (response.status === 401 || response.status === 403) {
      addGate({
        name: "OpenSign API reachability",
        status: "fail",
        detail: `OpenSign answered ${response.status}; token was rejected.`,
        next: "Check OPENSIGN_API_TOKEN and the API base URL.",
      });
      return;
    }
    addGate({
      name: "OpenSign API reachability",
      status: response.status >= 500 ? "warn" : "pass",
      detail: `OpenSign answered HTTP ${response.status} at ${base}. No document was sent.`,
      next:
        response.status >= 500
          ? "Retry after checking the OpenSign container/service logs."
          : undefined,
    });
  } catch (err) {
    addGate({
      name: "OpenSign API reachability",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      next: "Start OpenSign or fix OPENSIGN_API_BASE_URL/network routing.",
    });
  }
}

async function checkOpenSignWebhook(): Promise<void> {
  const secret = env("OPENSIGN_WEBHOOK_SECRET");
  if (!secret) {
    const required =
      process.env.NODE_ENV === "production" ||
      truthy(env("PUBLIC_WEBHOOK_REQUIRED")) ||
      truthy(env("OPEN_SIGN_WEBHOOK_REQUIRED")) ||
      truthy(env("OPENSIGN_WEBHOOK_REQUIRED"));
    addGate({
      name: "OpenSign webhook verification",
      status: required ? "fail" : "warn",
      detail: required
        ? "OPENSIGN_WEBHOOK_SECRET is not set; public/production webhook mode rejects unsigned OpenSign webhooks."
        : "OPENSIGN_WEBHOOK_SECRET is not set; local non-public webhook mode accepts unsigned OpenSign webhooks.",
      next: "Set the same webhook secret in OpenSign and backend env before exposing the webhook publicly.",
    });
    return;
  }

  const provider = getSigningProvider("opensign");
  const rawBody = Buffer.from(
    JSON.stringify({
      event: "DOCUMENT_COMPLETED",
      payload: { objectId: "mike-integration-probe" },
    }),
  );
  const signature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const accepted = provider.verifyWebhook({
    headers: { "x-webhook-signature": `sha256=${signature}` },
    rawBody,
    body: {},
  });
  const rejected = provider.verifyWebhook({
    headers: { "x-webhook-signature": "sha256=bad" },
    rawBody,
    body: {},
  });

  addGate({
    name: "OpenSign webhook verification",
    status: accepted && !rejected ? "pass" : "fail",
    detail:
      accepted && !rejected
        ? "Webhook HMAC accepts the correct signature and rejects an invalid one."
        : "Webhook HMAC verification did not behave as expected.",
    next:
      accepted && !rejected
        ? undefined
        : "Check OPENSIGN_WEBHOOK_SECRET and signature header handling.",
  });
}

async function checkPublicWebhookRouting(): Promise<void> {
  const required =
    truthy(env("PUBLIC_WEBHOOK_REQUIRED")) ||
    truthy(env("OPEN_SIGN_WEBHOOK_REQUIRED")) ||
    truthy(env("OPENSIGN_WEBHOOK_REQUIRED"));
  const baseUrl = publicMikeApiBaseUrl();
  if (!baseUrl) {
    addGate({
      name: "Public webhook routing",
      status: required ? "fail" : "warn",
      detail:
        "MIKE_PUBLIC_API_BASE_URL is not set, so the doctor cannot derive the OpenSign webhook callback URL.",
      next: "Set MIKE_PUBLIC_API_BASE_URL=https://your-mike-api-host and configure OpenSign to call /webhooks/signing/opensign.",
    });
    return;
  }
  if (!/^https:\/\//i.test(baseUrl)) {
    addGate({
      name: "Public webhook routing",
      status: required || !isLocalUrl(baseUrl) ? "fail" : "warn",
      detail: `Webhook base is not HTTPS: ${baseUrl}`,
      next: "Use an HTTPS public URL for OpenSign callbacks before exposing signing publicly.",
    });
    return;
  }
  if (isLocalUrl(baseUrl)) {
    addGate({
      name: "Public webhook routing",
      status: required ? "fail" : "warn",
      detail: `Webhook base points to a local address: ${baseUrl}`,
      next: "Use the Cloudflare-routed public API URL when testing webhooks from OpenSign.",
    });
    return;
  }
  addGate({
    name: "Public webhook routing",
    status: "pass",
    detail: `Configure OpenSign webhook target: ${baseUrl}/webhooks/signing/opensign`,
  });
}

function printReport(): void {
  const firstOpenGate =
    gates.find((gate) => gate.status === "fail") ??
    gates.find((gate) => gate.status === "warn");
  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          ok: !gates.some((gate) => gate.status === "fail"),
          gates,
          next_gate: firstOpenGate ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("\nMike integration doctor\n");
  for (const gate of gates) {
    console.log(`[${gate.status.toUpperCase()}] ${gate.name}`);
    console.log(`  ${gate.detail}`);
    if (gate.next) console.log(`  Next: ${gate.next}`);
  }
  if (firstOpenGate) {
    console.log(`\nNext gate: ${firstOpenGate.name}`);
    if (firstOpenGate.next) console.log(firstOpenGate.next);
  } else {
    console.log(
      "\nAll local readiness gates passed. Continue with the app UI flow: generate a document, send it through OpenSign, complete signing, and confirm the signed PDF imports.",
    );
  }
}

async function main(): Promise<void> {
  await checkGeneratedDocx();
  await checkPersistenceConfig();
  await checkPersistenceReachability();
  await checkStorageReadiness();
  await checkOllama();
  await checkLocalLegalAdvice();
  await checkAutoYouRuntimeAlignment();
  await checkAutoYouLegalAdviceBridge();
  await checkCloudFallback();
  await checkOpenSign();
  await checkOpenSignWebhook();
  await checkPublicWebhookRouting();
  printReport();

  const hasFailure = gates.some((gate) => gate.status === "fail");
  const hasWarning = gates.some((gate) => gate.status === "warn");
  if (hasFailure || (strict && hasWarning)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
