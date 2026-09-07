import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { streamOpenAI, completeOpenAIText } from "./openai";
import { completeOllamaText, streamOllama } from "./ollama";
import {
    DEFAULT_MAIN_MODEL,
    DEFAULT_TITLE_MODEL,
    providerForModel,
} from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";
export {
    checkOllamaHealth,
    isOllamaConfigured,
    resolveOllamaModel,
} from "./ollama";

function ollamaCloudFallbackEnabled(): boolean {
    const raw = process.env.OLLAMA_CLOUD_FALLBACK?.trim().toLowerCase();
    return raw !== "false" && raw !== "0" && raw !== "no";
}

function fallbackModel(defaultModel: string): string | null {
    const configured = process.env.OLLAMA_FALLBACK_MODEL?.trim() || defaultModel;
    if (!configured) return null;
    try {
        return providerForModel(configured) === "ollama" ? null : configured;
    } catch {
        return defaultModel;
    }
}

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const provider = providerForModel(params.model);
    if (provider === "ollama") {
        let emitted = false;
        const callbacks = params.callbacks;
        try {
            return await streamOllama({
                ...params,
                callbacks: {
                    ...callbacks,
                    onContentDelta: (text) => {
                        emitted = true;
                        callbacks?.onContentDelta?.(text);
                    },
                    onReasoningDelta: (text) => {
                        emitted = true;
                        callbacks?.onReasoningDelta?.(text);
                    },
                    onReasoningBlockEnd: () => {
                        callbacks?.onReasoningBlockEnd?.();
                    },
                    onToolCallStart: (call) => {
                        emitted = true;
                        callbacks?.onToolCallStart?.(call);
                    },
                },
            });
        } catch (err) {
            const fallback = fallbackModel(DEFAULT_MAIN_MODEL);
            if (!ollamaCloudFallbackEnabled() || emitted || !fallback) throw err;
            console.warn("[llm] Ollama stream failed before output; falling back", {
                model: params.model,
                fallback,
                error: err instanceof Error ? err.message : String(err),
            });
            return streamChatWithTools({ ...params, model: fallback });
        }
    }
    if (provider === "claude") return streamClaude(params);
    if (provider === "openai") return streamOpenAI(params);
    return streamGemini(params);
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    const provider = providerForModel(params.model);
    if (provider === "ollama") {
        try {
            return await completeOllamaText(params);
        } catch (err) {
            const fallback = fallbackModel(DEFAULT_TITLE_MODEL);
            if (!ollamaCloudFallbackEnabled() || !fallback) throw err;
            console.warn("[llm] Ollama completion failed; falling back", {
                model: params.model,
                fallback,
                error: err instanceof Error ? err.message : String(err),
            });
            return completeText({ ...params, model: fallback });
        }
    }
    if (provider === "claude") return completeClaudeText(params);
    if (provider === "openai") return completeOpenAIText(params);
    return completeGeminiText(params);
}
