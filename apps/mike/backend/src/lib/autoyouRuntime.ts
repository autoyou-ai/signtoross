import { ollamaBaseUrl, resolveOllamaModel } from "./llm/ollama";

type JsonRecord = Record<string, unknown>;

export type AutoYouRuntimeHealth = {
  configured: boolean;
  required: boolean;
  reachable: boolean;
  baseUrl: string;
  chatBaseUrl: string;
  envAligned: boolean;
  mike: {
    aiProvider: string | null;
    ollamaApiBase: string | null;
    ollamaBaseUrlAlias: string | null;
    effectiveOllamaBaseUrl: string;
    ollamaModel: string;
  };
  runtime?: {
    status?: string | null;
    service?: string | null;
    aiProvider?: string | null;
    adminPort?: number | null;
    aiAgentPort?: number | null;
  };
  warnings: string[];
  error?: string;
};

export type AutoYouLegalAdviceProbe = {
  reachable: boolean;
  baseUrl: string;
  response: string;
  sessionId: string | null;
  agentName: string | null;
  model: string;
  error?: string;
};

const DEFAULT_ADMIN_BASE_URL = "http://127.0.0.1:8001";
const DEFAULT_CHAT_PORT = "8081";

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function truthy(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

async function fetchJson(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; json: JsonRecord | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    const json = (await response.json().catch(() => null)) as unknown;
    return {
      ok: response.ok,
      status: response.status,
      json: record(json),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function autoyouAdminBaseUrl(): string {
  return cleanBaseUrl(
    env("AUTOYOU_ADMIN_API_BASE") ||
      env("AUTOYOU_ADMIN_BASE_URL") ||
      env("AUTOYOU_RUNTIME_API_BASE") ||
      DEFAULT_ADMIN_BASE_URL,
  );
}

export function autoyouChatBaseUrl(): string {
  const explicit =
    env("AUTOYOU_CHAT_API_BASE") ||
    env("AUTOYOU_AI_API_BASE") ||
    env("AUTOYOU_AI_AGENT_API_BASE");
  if (explicit) return cleanBaseUrl(explicit);

  const port =
    env("AUTOYOU_AI_PORT") ||
    env("AUTOYOU_AI_AGENT_SERVER_PORT") ||
    DEFAULT_CHAT_PORT;
  return `http://127.0.0.1:${port}`;
}

export function isAutoYouRuntimeConfigured(): boolean {
  return Boolean(
    env("AUTOYOU_ADMIN_API_BASE") ||
    env("AUTOYOU_ADMIN_BASE_URL") ||
    env("AUTOYOU_RUNTIME_API_BASE") ||
    env("AUTOYOU_CHAT_API_BASE") ||
    env("AUTOYOU_AI_API_BASE") ||
    env("AUTOYOU_AI_AGENT_API_BASE"),
  );
}

export async function checkAutoYouRuntime(
  timeoutMs = 1500,
): Promise<AutoYouRuntimeHealth> {
  const baseUrl = autoyouAdminBaseUrl();
  const chatBaseUrl = autoyouChatBaseUrl();
  const configured = isAutoYouRuntimeConfigured();
  const required = truthy(env("AUTOYOU_RUNTIME_REQUIRED"));
  const aiProvider = env("AI_PROVIDER") || null;
  const ollamaApiBase = env("OLLAMA_API_BASE") || null;
  const ollamaBaseUrlAlias = env("OLLAMA_BASE_URL") || null;
  const effectiveOllamaBaseUrl = ollamaBaseUrl();
  const ollamaModel = resolveOllamaModel("ollama:default");
  const warnings: string[] = [];

  if ((aiProvider ?? "").toLowerCase() !== "ollama") {
    warnings.push("AI_PROVIDER is not set to ollama.");
  }
  if (!ollamaApiBase) {
    warnings.push(
      "OLLAMA_API_BASE is not set. Mike may still work through OLLAMA_BASE_URL, but AutoYou uses OLLAMA_API_BASE.",
    );
  } else if (cleanBaseUrl(ollamaApiBase) !== effectiveOllamaBaseUrl) {
    warnings.push(
      `OLLAMA_API_BASE (${cleanBaseUrl(ollamaApiBase)}) does not match Mike's effective Ollama base (${effectiveOllamaBaseUrl}).`,
    );
  }
  if (!env("OLLAMA_MODEL") && ollamaModel !== "ministral-3:8b") {
    warnings.push(
      `OLLAMA_MODEL is not set and the resolved Mike model is ${ollamaModel}. AutoYou defaults to ministral-3:8b.`,
    );
  }

  const envAligned = warnings.length === 0;

  try {
    const [statusResult, configResult] = await Promise.all([
      fetchJson(`${baseUrl}/api/status`, timeoutMs),
      fetchJson(`${baseUrl}/api/v1/server-config`, timeoutMs),
    ]);
    if (!statusResult.ok && !configResult.ok) {
      return {
        configured,
        required,
        reachable: false,
        baseUrl,
        chatBaseUrl,
        envAligned,
        mike: {
          aiProvider,
          ollamaApiBase,
          ollamaBaseUrlAlias,
          effectiveOllamaBaseUrl,
          ollamaModel,
        },
        warnings,
        error: `AutoYou admin responded ${statusResult.status}/${configResult.status}.`,
      };
    }

    const statusJson = statusResult.json ?? {};
    const configJson = configResult.json ?? {};
    const instance = record(statusJson.instance);
    const ports = record(instance.ports);
    const adminPort =
      typeof ports.admin === "number" && Number.isFinite(ports.admin)
        ? ports.admin
        : null;
    const aiAgentPort =
      typeof ports.ai_agent === "number" && Number.isFinite(ports.ai_agent)
        ? ports.ai_agent
        : typeof ports.aiAgent === "number" && Number.isFinite(ports.aiAgent)
          ? ports.aiAgent
          : null;
    const runtimeAiProvider =
      typeof configJson.ai_provider === "string"
        ? configJson.ai_provider
        : null;
    if (runtimeAiProvider && runtimeAiProvider.toLowerCase() !== "ollama") {
      warnings.push(
        `AutoYou runtime reports ai_provider=${runtimeAiProvider}; expected ollama for local legal model generation.`,
      );
    }

    return {
      configured,
      required,
      reachable: true,
      baseUrl,
      chatBaseUrl,
      envAligned: warnings.length === 0,
      mike: {
        aiProvider,
        ollamaApiBase,
        ollamaBaseUrlAlias,
        effectiveOllamaBaseUrl,
        ollamaModel,
      },
      runtime: {
        status:
          typeof statusJson.status === "string" ? statusJson.status : null,
        service:
          typeof statusJson.service === "string" ? statusJson.service : null,
        aiProvider: runtimeAiProvider,
        adminPort,
        aiAgentPort,
      },
      warnings,
    };
  } catch (err) {
    return {
      configured,
      required,
      reachable: false,
      baseUrl,
      chatBaseUrl,
      envAligned,
      mike: {
        aiProvider,
        ollamaApiBase,
        ollamaBaseUrlAlias,
        effectiveOllamaBaseUrl,
        ollamaModel,
      },
      warnings,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function requestAutoYouLegalAdvice(args: {
  question: string;
  context?: JsonRecord[];
  sessionId?: string;
  userId?: string;
  timeoutMs?: number;
}): Promise<AutoYouLegalAdviceProbe> {
  const baseUrl = autoyouChatBaseUrl();
  const model = resolveOllamaModel("ollama:default");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 30_000);
  timer.unref?.();

  const message = [
    "You are AutoYou SignToROSS providing local-model legal workflow assistance for Mike.",
    "Use the configured local Ollama model and avoid cloud-provider references.",
    "Return a concise, practical legal drafting answer. Mention OpenSign only if signature execution is relevant.",
    "",
    args.question,
  ].join("\n");

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        message,
        session_id: args.sessionId ?? "autoyou-signtoross-legal-advice-probe",
        user_id: args.userId ?? "mike-integration-doctor",
        context: args.context ?? [],
        metadata: {
          client: "mike",
          purpose: "signtoross_probe",
          ai_provider: "ollama",
          ollama_api_base: ollamaBaseUrl(),
          ollama_model: model,
        },
      }),
    });
    const json = (await response.json().catch(() => null)) as unknown;
    const payload = record(json);
    if (!response.ok) {
      return {
        reachable: false,
        baseUrl,
        response: "",
        sessionId: null,
        agentName: null,
        model,
        error: `AutoYou chat responded HTTP ${response.status}.`,
      };
    }

    const answer =
      typeof payload.response === "string"
        ? payload.response.trim()
        : typeof payload.message === "string"
          ? payload.message.trim()
          : "";
    return {
      reachable: true,
      baseUrl,
      response: answer,
      sessionId:
        typeof payload.session_id === "string" ? payload.session_id : null,
      agentName:
        typeof payload.agent_name === "string" ? payload.agent_name : null,
      model,
      error: answer ? undefined : "AutoYou chat returned an empty response.",
    };
  } catch (err) {
    return {
      reachable: false,
      baseUrl,
      response: "",
      sessionId: null,
      agentName: null,
      model,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
