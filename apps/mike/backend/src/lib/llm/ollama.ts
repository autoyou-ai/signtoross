import crypto from "crypto";
import type {
    LlmMessage,
    NormalizedToolCall,
    NormalizedToolResult,
    OpenAIToolSchema,
    StreamChatParams,
    StreamChatResult,
} from "./types";

type OllamaMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    thinking?: string;
    tool_calls?: OllamaToolCall[];
    tool_name?: string;
};

type OllamaToolCall = {
    id?: string;
    function?: {
        name?: string;
        arguments?: Record<string, unknown> | string;
        description?: string;
    };
};

type OllamaChatChunk = {
    error?: string;
    message?: {
        role?: string;
        content?: string;
        thinking?: string;
        tool_calls?: OllamaToolCall[];
    };
    done?: boolean;
};

type OllamaChatResponse = {
    error?: string;
    message?: {
        role?: string;
        content?: string;
        thinking?: string;
        tool_calls?: OllamaToolCall[];
    };
    response?: string;
};

type OllamaTagsResponse = {
    models?: { name?: string; model?: string }[];
};

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "ministral-3:8b";

export type OllamaHealth = {
    configured: boolean;
    reachable: boolean;
    baseUrl: string;
    model: string;
    modelInstalled: boolean | null;
    version?: string;
    error?: string;
};

export function ollamaBaseUrl(): string {
    return (
        process.env.OLLAMA_BASE_URL?.trim() ||
        process.env.OLLAMA_API_BASE?.trim() ||
        process.env.OLLAMA_API_URL?.trim() ||
        DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
}

export function isOllamaConfigured(): boolean {
    const enabled = process.env.OLLAMA_ENABLED?.trim().toLowerCase();
    if (enabled === "false" || enabled === "0" || enabled === "no") {
        return false;
    }
    const activeProvider = process.env.AI_PROVIDER?.trim().toLowerCase();
    return (
        enabled === "true" ||
        activeProvider === "ollama" ||
        !!process.env.OLLAMA_MODEL?.trim()
    );
}

export function resolveOllamaModel(model: string): string {
    const suffix = model.startsWith("ollama:") ? model.slice("ollama:".length) : "";
    if (!suffix || suffix === "default") {
        return process.env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL;
    }
    return suffix;
}

function timeoutSignal(ms: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms).unref();
    return controller.signal;
}

async function ollamaFetch(
    path: string,
    init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
    const { timeoutMs, ...requestInit } = init ?? {};
    const response = await fetch(`${ollamaBaseUrl()}${path}`, {
        ...requestInit,
        signal: requestInit.signal ?? timeoutSignal(timeoutMs ?? 30_000),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
            `Ollama ${path} failed (${response.status}): ${text || response.statusText}`,
        );
    }
    return response;
}

function toNativeMessages(
    systemPrompt: string | undefined,
    messages: LlmMessage[],
): OllamaMessage[] {
    const native: OllamaMessage[] = [];
    if (systemPrompt?.trim()) {
        native.push({ role: "system", content: systemPrompt });
    }
    for (const message of messages) {
        native.push({
            role: message.role,
            content: message.content,
        });
    }
    return native;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    if (typeof value !== "string" || !value.trim()) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function normalizeToolCall(call: OllamaToolCall, index: number): NormalizedToolCall {
    const name = call.function?.name?.trim() || "tool";
    const input = parseToolArguments(call.function?.arguments);
    const stable = crypto
        .createHash("sha256")
        .update(`${name}:${JSON.stringify(input)}:${index}`)
        .digest("hex")
        .slice(0, 12);
    return {
        id: call.id?.trim() || `${name}-${stable}`,
        name,
        input,
    };
}

async function* readJsonLines(response: Response): AsyncGenerator<OllamaChatChunk> {
    if (!response.body) throw new Error("Ollama response had no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            yield JSON.parse(trimmed) as OllamaChatChunk;
        }
    }

    const tail = buffer.trim();
    if (tail) yield JSON.parse(tail) as OllamaChatChunk;
}

export async function streamOllama(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    if (!isOllamaConfigured()) {
        throw new Error(
            "Ollama is not enabled. Set OLLAMA_ENABLED=true, AI_PROVIDER=ollama, or OLLAMA_MODEL in backend/.env.",
        );
    }

    const {
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        enableThinking,
    } = params;
    const model = resolveOllamaModel(params.model);
    const messages = toNativeMessages(systemPrompt, params.messages);
    const maxIter = params.maxIterations ?? 10;
    let fullText = "";
    let requestThinking = !!enableThinking;

    for (let iter = 0; iter < maxIter; iter++) {
        const requestBody = {
            model,
            messages,
            tools: tools.length ? tools : undefined,
            stream: true,
            ...(requestThinking ? { think: true } : {}),
        };
        let response: Response;
        try {
            response = await ollamaFetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });
        } catch (err) {
            if (
                requestThinking &&
                err instanceof Error &&
                /does not support thinking/i.test(err.message)
            ) {
                requestThinking = false;
                response = await ollamaFetch("/api/chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ...requestBody, think: undefined }),
                });
            } else {
                throw err;
            }
        }

        let assistantText = "";
        let assistantThinking = "";
        let rawToolCalls: OllamaToolCall[] = [];

        for await (const chunk of readJsonLines(response)) {
            if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
            const content = chunk.message?.content ?? "";
            if (content) {
                assistantText += content;
                fullText += content;
                callbacks.onContentDelta?.(content);
            }
            const thinking = chunk.message?.thinking ?? "";
            if (thinking) {
                assistantThinking += thinking;
                callbacks.onReasoningDelta?.(thinking);
            }
            if (chunk.message?.tool_calls?.length) {
                rawToolCalls = chunk.message.tool_calls;
            }
        }

        if (assistantThinking) callbacks.onReasoningBlockEnd?.();

        const toolCalls = rawToolCalls.map(normalizeToolCall);
        if (!toolCalls.length || !runTools) break;

        for (const call of toolCalls) callbacks.onToolCallStart?.(call);

        messages.push({
            role: "assistant",
            content: assistantText,
            thinking: assistantThinking || undefined,
            tool_calls: rawToolCalls,
        });

        const results = await runTools(toolCalls);
        for (const result of results) {
            const matchingCall = toolCalls.find(
                (call) => call.id === result.tool_use_id,
            );
            messages.push({
                role: "tool",
                content: result.content,
                tool_name: matchingCall?.name,
            });
        }
    }

    return { fullText };
}

export async function completeOllamaText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
}): Promise<string> {
    if (!isOllamaConfigured()) {
        throw new Error(
            "Ollama is not enabled. Set OLLAMA_ENABLED=true, AI_PROVIDER=ollama, or OLLAMA_MODEL in backend/.env.",
        );
    }

    const messages = toNativeMessages(params.systemPrompt, [
        { role: "user", content: params.user },
    ]);
    const response = await ollamaFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: resolveOllamaModel(params.model),
            messages,
            stream: false,
            think: false,
            options: params.maxTokens ? { num_predict: params.maxTokens } : undefined,
        }),
    });
    const json = (await response.json()) as OllamaChatResponse;
    if (json.error) throw new Error(`Ollama error: ${json.error}`);
    return json.message?.content ?? json.response ?? "";
}

export async function checkOllamaHealth(
    modelId = "ollama:default",
    timeoutMs = 1500,
): Promise<OllamaHealth> {
    const model = resolveOllamaModel(modelId);
    const baseUrl = ollamaBaseUrl();
    const configured = isOllamaConfigured();
    if (!configured) {
        return {
            configured,
            reachable: false,
            baseUrl,
            model,
            modelInstalled: null,
            error: "Ollama is not enabled in backend configuration.",
        };
    }

    try {
        const [versionResponse, tagsResponse] = await Promise.all([
            ollamaFetch("/api/version", { timeoutMs }),
            ollamaFetch("/api/tags", { timeoutMs }),
        ]);
        const versionJson = (await versionResponse.json().catch(() => ({}))) as {
            version?: string;
        };
        const tagsJson = (await tagsResponse.json().catch(() => ({}))) as OllamaTagsResponse;
        const installedNames = new Set(
            (tagsJson.models ?? [])
                .flatMap((entry) => [entry.name, entry.model])
                .filter((entry): entry is string => !!entry),
        );
        return {
            configured,
            reachable: true,
            baseUrl,
            model,
            modelInstalled: installedNames.has(model),
            version: versionJson.version,
        };
    } catch (err) {
        return {
            configured,
            reachable: false,
            baseUrl,
            model,
            modelInstalled: null,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

export type { NormalizedToolResult, OpenAIToolSchema };
