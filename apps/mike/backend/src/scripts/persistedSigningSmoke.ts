import "dotenv/config";
import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";
import { createServerSupabase } from "../lib/supabase";
import { storageKey, uploadFile, deleteFile } from "../lib/storage";
import {
    buildSignedPdfUrl,
    listDocumentSignatureRequests,
    loadSignatureRequestDetail,
    syncSignatureRequestFromProvider,
} from "../lib/signatureRequests";
import { getSigningProvider } from "../lib/signing";
import { parseFirstJsonObject } from "./jsonOutput";

type EnvSnapshot = Record<string, string | undefined>;

type WatchSnapshot = {
    status?: string;
    signed_pdf_imported?: boolean;
    ready_to_download?: boolean;
    next_action?: string;
    recipients?: { status?: string; signing_url_recorded?: boolean }[];
    events?: { event_type?: string }[];
};

const SOURCE_PDF = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
    "utf8",
);
const SIGNED_PDF = Buffer.from(
    "%PDF-1.4\n% mike signed smoke pdf\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
    "utf8",
);

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
    return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
            try {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

async function listen(
    handler: http.RequestListener,
): Promise<{ server: http.Server; url: string }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${address.port}` };
}

function snapshotEnv(names: string[]): EnvSnapshot {
    return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
    for (const [name, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
}

function runSignatureWatcher(requestId: string): WatchSnapshot {
    const backendRoot = path.resolve(__dirname, "..", "..");
    const repoRoot = path.resolve(backendRoot, "..");
    const npmExecPath = process.env.npm_execpath;
    const npmCommand = npmExecPath
        ? process.execPath
        : process.platform === "win32"
            ? "npm.cmd"
            : "npm";
    const npmBaseArgs = npmExecPath ? [npmExecPath] : [];
    const result = spawnSync(
        npmCommand,
        [...npmBaseArgs, "run", "integration:signature-watch", "--prefix", backendRoot],
        {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                SIGNATURE_REQUEST_ID: requestId,
                SIGNATURE_WATCH_JSON: "true",
            },
        },
    );

    if (result.status !== 0) {
        throw new Error(
            `Signature watcher failed: ${result.stdout}\n${result.stderr}`,
        );
    }
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const parsed = parseFirstJsonObject<WatchSnapshot>(output);
    if (!parsed) {
        throw new Error(`Signature watcher did not return JSON: ${output}`);
    }
    return parsed;
}

async function startMockOpenSign() {
    return listen(async (req, res) => {
        if (req.url !== "/signed.pdf" && req.headers["x-api-token"] !== "test-token") {
            json(res, 401, { error: "missing token" });
            return;
        }

        if (req.method === "POST" && req.url === "/createdocument") {
            const body = await readJson(req);
            assert.equal(typeof body.external_id, "string");
            assert.equal(typeof body.file, "string");
            assert.equal(Array.isArray(body.signers), true);
            assert.equal(Array.isArray(body.widgets), true);
            json(res, 200, {
                objectId: "opensign-persisted-smoke-1",
                status: "sent",
                Signers: [
                    {
                        objectId: "recipient-persisted-1",
                        email: "signer@example.invalid",
                        Status: "sent",
                    },
                ],
            });
            return;
        }

        if (
            req.method === "GET" &&
            req.url === "/signinglinks/opensign-persisted-smoke-1"
        ) {
            json(res, 200, {
                signingLinks: [
                    {
                        objectId: "recipient-persisted-1",
                        email: "signer@example.invalid",
                        signurl: "https://sign.example.invalid/request/persisted-smoke",
                    },
                ],
            });
            return;
        }

        if (
            req.method === "GET" &&
            req.url === "/document/opensign-persisted-smoke-1"
        ) {
            const host = req.headers.host;
            json(res, 200, {
                objectId: "opensign-persisted-smoke-1",
                title: "Persisted OpenSign Smoke",
                status: "completed",
                completedAt: "2026-06-12T12:00:00.000Z",
                Signers: [
                    {
                        objectId: "recipient-persisted-1",
                        email: "signer@example.invalid",
                        Status: "completed",
                        signedAt: "2026-06-12T12:00:00.000Z",
                    },
                ],
                SignedUrl: `http://${host}/signed.pdf`,
            });
            return;
        }

        if (req.method === "GET" && req.url === "/signed.pdf") {
            res.writeHead(200, { "Content-Type": "application/pdf" });
            res.end(SIGNED_PDF);
            return;
        }

        json(res, 404, { error: "not found" });
    });
}

async function cleanupSmokeRows(args: {
    db: ReturnType<typeof createServerSupabase>;
    documentId: string;
    storagePaths: Set<string>;
}): Promise<void> {
    const { db, documentId, storagePaths } = args;
    const { data: versions } = await db
        .from("document_versions")
        .select("storage_path, pdf_storage_path")
        .eq("document_id", documentId);
    for (const version of versions ?? []) {
        if (typeof version.storage_path === "string") storagePaths.add(version.storage_path);
        if (typeof version.pdf_storage_path === "string") {
            storagePaths.add(version.pdf_storage_path);
        }
    }
    await db.from("documents").delete().eq("id", documentId);
    for (const path of storagePaths) {
        await deleteFile(path).catch(() => undefined);
    }
}

async function main(): Promise<void> {
    const envSnapshot = snapshotEnv([
        "SIGNING_PROVIDER",
        "OPENSIGN_API_MODE",
        "OPENSIGN_API_BASE_URL",
        "OPENSIGN_API_TOKEN",
    ]);
    const db = createServerSupabase();
    const { server, url } = await startMockOpenSign();
    const userId = `integration-smoke-${crypto.randomUUID()}`;
    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const storagePaths = new Set<string>();

    try {
        process.env.SIGNING_PROVIDER = "opensign";
        process.env.OPENSIGN_API_MODE = "token";
        process.env.OPENSIGN_API_BASE_URL = url;
        process.env.OPENSIGN_API_TOKEN = "test-token";

        const sourceKey = storageKey(
            userId,
            documentId,
            "persisted-opensign-smoke.pdf",
        );
        storagePaths.add(sourceKey);
        await uploadFile(sourceKey, toArrayBuffer(SOURCE_PDF), "application/pdf");

        const now = new Date().toISOString();
        const { error: docError } = await db.from("documents").insert({
            id: documentId,
            project_id: null,
            user_id: userId,
            filename: "persisted-opensign-smoke.pdf",
            file_type: "pdf",
            size_bytes: SOURCE_PDF.byteLength,
            page_count: 1,
            status: "ready",
            created_at: now,
            updated_at: now,
        });
        if (docError) throw new Error(docError.message);

        const { error: versionError } = await db.from("document_versions").insert({
            id: versionId,
            document_id: documentId,
            storage_path: sourceKey,
            pdf_storage_path: sourceKey,
            source: "generated",
            version_number: 1,
            display_name: "persisted-opensign-smoke.pdf",
        });
        if (versionError) throw new Error(versionError.message);

        const { error: docUpdateError } = await db
            .from("documents")
            .update({ current_version_id: versionId })
            .eq("id", documentId);
        if (docUpdateError) throw new Error(docUpdateError.message);

        const provider = getSigningProvider("opensign");
        const { error: requestInsertError } = await db
            .from("signature_requests")
            .insert({
                id: requestId,
                document_id: documentId,
                document_version_id: versionId,
                user_id: userId,
                provider: provider.name,
                status: "draft",
                subject: "Persisted OpenSign smoke",
                message: "Please sign the persisted smoke document.",
                source_pdf_path: sourceKey,
                created_at: now,
                updated_at: now,
            });
        if (requestInsertError) throw new Error(requestInsertError.message);

        const providerResult = await provider.createSignatureRequest({
            requestId,
            documentId,
            title: "Persisted OpenSign Smoke",
            filename: "persisted-opensign-smoke.pdf",
            pdfBytes: toArrayBuffer(SOURCE_PDF),
            pageCount: 1,
            subject: "Persisted OpenSign smoke",
            message: "Please sign the persisted smoke document.",
            expiresAt: null,
            recipients: [
                {
                    name: "Smoke Signer",
                    email: "signer@example.invalid",
                    role: "SIGNER",
                    signingOrder: 1,
                },
            ],
        });
        assert.equal(providerResult.providerRequestId, "opensign-persisted-smoke-1");

        const { error: requestUpdateError } = await db
            .from("signature_requests")
            .update({
                provider_request_id: providerResult.providerRequestId,
                status: providerResult.status,
                provider_payload: providerResult.providerPayload,
                sent_at: providerResult.sentAt,
                updated_at: new Date().toISOString(),
            })
            .eq("id", requestId);
        if (requestUpdateError) throw new Error(requestUpdateError.message);

        const { error: recipientsError } = await db.from("signature_recipients").insert(
            providerResult.recipients.map((recipient) => ({
                signature_request_id: requestId,
                name: recipient.name,
                email: recipient.email,
                role: recipient.role,
                signing_order: recipient.signingOrder ?? 1,
                provider_recipient_id: recipient.providerRecipientId,
                signing_url: recipient.signingUrl,
                status: recipient.status,
                opened_at: recipient.openedAt ?? null,
                signed_at: recipient.signedAt ?? null,
            })),
        );
        if (recipientsError) throw new Error(recipientsError.message);

        const historyBeforeSync = await listDocumentSignatureRequests(db, documentId);
        assert.equal(historyBeforeSync.length, 1);
        assert.equal(historyBeforeSync[0]?.status, "sent");
        assert.equal(
            (historyBeforeSync[0]?.recipients as { signing_url?: string }[])[0]
                ?.signing_url,
            "https://sign.example.invalid/request/persisted-smoke",
        );

        const synced = await syncSignatureRequestFromProvider({
            db,
            requestId,
            provider,
        });
        assert.equal(synced.detail?.status, "completed");
        assert.ok(synced.importedSignedPdfPath);
        storagePaths.add(synced.importedSignedPdfPath as string);

        const detail = await loadSignatureRequestDetail(db, requestId);
        assert.equal(detail?.status, "completed");
        assert.equal(detail?.signed_pdf_path, synced.importedSignedPdfPath);
        assert.equal(
            Array.isArray(detail?.events) &&
                detail.events.some(
                    (event: { event_type?: string }) =>
                        event.event_type === "PROVIDER_STATUS_SYNC",
                ),
            true,
        );
        assert.equal(
            Array.isArray(detail?.recipients) &&
                detail.recipients[0]?.status === "signed",
            true,
        );

        const signedUrl = await buildSignedPdfUrl(db, requestId);
        assert.equal(typeof signedUrl?.url, "string");
        assert.equal(signedUrl?.filename.endsWith("[Signed].pdf"), true);

        const watched = runSignatureWatcher(requestId);
        assert.equal(watched.status, "completed");
        assert.equal(watched.signed_pdf_imported, true);
        assert.equal(watched.ready_to_download, true);
        assert.equal(watched.next_action, "download_signed_pdf");
        assert.equal(
            watched.recipients?.some(
                (recipient) =>
                    recipient.status === "signed" &&
                    recipient.signing_url_recorded === true,
            ),
            true,
        );
        assert.equal(
            watched.events?.some(
                (event) => event.event_type === "PROVIDER_STATUS_SYNC",
            ),
            true,
        );

        const { data: docAfter } = await db
            .from("documents")
            .select("filename, file_type, current_version_id")
            .eq("id", documentId)
            .single();
        assert.equal(docAfter?.file_type, "pdf");
        assert.equal(
            typeof docAfter?.filename === "string" &&
                docAfter.filename.endsWith("[Signed].pdf"),
            true,
        );

        console.log("Persisted signing smoke passed");
        console.log(`Document: ${documentId}`);
        console.log(`Signature request: ${requestId}`);
        console.log("Verified: storage upload, DB rows, OpenSign create, provider sync, signed-PDF import, signed URL, and signature watcher JSON.");
    } finally {
        await cleanupSmokeRows({ db, documentId, storagePaths });
        restoreEnv(envSnapshot);
        await new Promise<void>((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
        );
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
