import assert from "node:assert/strict";
import http from "node:http";
import { streamOllama } from "../lib/llm/ollama";

async function main() {
    const requests: Record<string, unknown>[] = [];
    const server = http.createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        requests.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(JSON.stringify({ message: { content: "Started " } }) + "\n");
        setTimeout(() => {
            if (!res.destroyed) {
                res.end(JSON.stringify({ message: { content: "finished" }, done: true }) + "\n");
            }
        }, 250);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const changes = {
        OLLAMA_ENABLED: "true",
        OLLAMA_BASE_URL: `http://127.0.0.1:${address.port}`,
        OLLAMA_NUM_CTX: "4096",
        OLLAMA_NUM_PREDICT: "512",
        OLLAMA_TEMPERATURE: "0.2",
        OLLAMA_CHAT_TIMEOUT_MS: "100",
    };
    const original = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
    Object.assign(process.env, changes);
    const params = { model: "ollama:test", systemPrompt: "Test", messages: [{ role: "user" as const, content: "Hello" }] };
    try {
        // The deadline must cover the streamed body, even after headers arrive.
        await assert.rejects(streamOllama(params), { name: "AbortError" });
        process.env.OLLAMA_CHAT_TIMEOUT_MS = "2000";
        const result = await streamOllama(params);
        assert.equal(result.fullText, "Started finished");
        assert.deepEqual(requests[1].options, { num_ctx: 4096, num_predict: 512, temperature: 0.2 });
        console.log("Ollama stream deadline and generation options smoke passed");
    } finally {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
