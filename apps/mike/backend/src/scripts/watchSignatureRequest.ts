import "dotenv/config";
import { createServerSupabase } from "../lib/supabase";
import {
    buildSignedPdfUrl,
    listDocumentSignatureRequests,
    loadSignatureRequestDetail,
    syncSignatureRequestFromProvider,
} from "../lib/signatureRequests";
import { getSigningProvider } from "../lib/signing";
import type { SigningStatus } from "../lib/signing";

const args = process.argv.slice(2);
const TERMINAL_STATUSES = new Set<SigningStatus>([
    "completed",
    "declined",
    "expired",
    "cancelled",
    "failed",
]);

type WatchRecipient = {
    signing_order: unknown;
    role: unknown;
    status: unknown;
    email_masked: string;
    signing_url_recorded: boolean;
    signing_url?: string;
};

type WatchEvent = {
    received_at: unknown;
    event_type: unknown;
    provider_event_id: unknown;
};

type WatchSnapshot = {
    found: boolean;
    request_id: string;
    document_id: unknown;
    provider: unknown;
    provider_request_id: unknown;
    status: SigningStatus | null;
    terminal: boolean;
    sent_at: unknown;
    completed_at: unknown;
    signed_pdf_path: unknown;
    signed_pdf_imported: boolean;
    signed_pdf_url_available: boolean;
    signed_pdf_filename: string | null;
    ready_to_download: boolean;
    recipients: WatchRecipient[];
    events: WatchEvent[];
    event_count: number;
    warnings: string[];
    next_action: string;
};

function env(name: string): string {
    return process.env[name]?.trim() ?? "";
}

function argValue(flag: string): string | null {
    const index = args.indexOf(flag);
    if (index < 0) return null;
    return args[index + 1]?.trim() || null;
}

function flag(name: string): boolean {
    return args.includes(name);
}

function envFlag(name: string): boolean {
    return ["1", "true", "yes", "on"].includes(env(name).toLowerCase());
}

function jsonMode(): boolean {
    return (
        flag("--json") ||
        envFlag("SIGNATURE_WATCH_JSON") ||
        envFlag("SIGNATURE_JSON")
    );
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskEmail(value: unknown): string {
    if (typeof value !== "string" || !value.includes("@")) return String(value ?? "");
    const [local, domain] = value.split("@");
    const visible = local.slice(0, 2);
    return `${visible}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

function fmt(value: unknown): string {
    return typeof value === "string" && value.trim() ? value.trim() : "-";
}

function rowId(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberArg(flagName: string, envName: string, fallback: number): number {
    const raw = argValue(flagName) ?? env(envName);
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nextAction(args: {
    status: SigningStatus | null;
    providerRequestId: unknown;
    signedPdfImported: boolean;
    readyToDownload: boolean;
}): string {
    if (!args.status) return "request_not_found";
    if (!args.providerRequestId) return "wait_for_provider_request_id";
    if (args.status === "completed" && args.readyToDownload) {
        return "download_signed_pdf";
    }
    if (args.status === "completed" && !args.signedPdfImported) {
        return "investigate_signed_pdf_import";
    }
    if (args.status === "completed") return "wait_for_signed_pdf_url";
    if (TERMINAL_STATUSES.has(args.status)) return "review_terminal_status";
    return "wait_for_recipient_completion";
}

async function latestRequestId(
    db: ReturnType<typeof createServerSupabase>,
): Promise<string | null> {
    const { data, error } = await db
        .from("signature_requests")
        .select("id")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return rowId(data?.id);
}

async function requestIdForDocument(
    db: ReturnType<typeof createServerSupabase>,
    documentId: string,
): Promise<string | null> {
    const requests = await listDocumentSignatureRequests(db, documentId);
    return rowId(requests[0]?.id);
}

async function resolveRequestId(
    db: ReturnType<typeof createServerSupabase>,
): Promise<string | null> {
    const explicit =
        argValue("--request-id") ||
        argValue("--id") ||
        env("SIGNATURE_REQUEST_ID");
    if (explicit) return explicit;

    const documentId =
        argValue("--document-id") ||
        argValue("--doc-id") ||
        env("SIGNATURE_DOCUMENT_ID");
    if (documentId) return requestIdForDocument(db, documentId);

    return latestRequestId(db);
}

async function loadSnapshot(
    db: ReturnType<typeof createServerSupabase>,
    requestId: string,
): Promise<WatchSnapshot> {
    const detail = await loadSignatureRequestDetail(db, requestId);
    if (!detail) {
        return {
            found: false,
            request_id: requestId,
            document_id: null,
            provider: null,
            provider_request_id: null,
            status: null,
            terminal: false,
            sent_at: null,
            completed_at: null,
            signed_pdf_path: null,
            signed_pdf_imported: false,
            signed_pdf_url_available: false,
            signed_pdf_filename: null,
            ready_to_download: false,
            recipients: [],
            events: [],
            event_count: 0,
            warnings: [`Signature request not found: ${requestId}`],
            next_action: "request_not_found",
        };
    }

    const status = detail.status as SigningStatus;
    const signed = await buildSignedPdfUrl(db, requestId).catch(() => null);
    const recipients = Array.isArray(detail.recipients)
        ? (detail.recipients as Record<string, unknown>[])
        : [];
    const events = Array.isArray(detail.events)
        ? (detail.events as Record<string, unknown>[])
        : [];
    const signedPdfImported = !!detail.signed_pdf_path;
    const readyToDownload = signedPdfImported && !!signed?.url;
    const warnings: string[] = [];
    if (status === "completed" && !signedPdfImported) {
        warnings.push(
            "Request is completed but signed_pdf_path is empty. Webhook matching worked, but signed-PDF import did not finish.",
        );
    }

    return {
        found: true,
        request_id: String(detail.id),
        document_id: detail.document_id,
        provider: detail.provider,
        provider_request_id: detail.provider_request_id,
        status,
        terminal: TERMINAL_STATUSES.has(status),
        sent_at: detail.sent_at,
        completed_at: detail.completed_at,
        signed_pdf_path: detail.signed_pdf_path,
        signed_pdf_imported: signedPdfImported,
        signed_pdf_url_available: !!signed?.url,
        signed_pdf_filename: signed?.filename ?? null,
        ready_to_download: readyToDownload,
        recipients: recipients.map((recipient) => {
            const signingUrl = fmt(recipient.signing_url);
            return {
                signing_order: recipient.signing_order,
                role: recipient.role,
                status: recipient.status,
                email_masked: maskEmail(recipient.email),
                signing_url_recorded: signingUrl !== "-",
                ...(flag("--show-links") && signingUrl !== "-"
                    ? { signing_url: signingUrl }
                    : {}),
            };
        }),
        events: events.slice(0, 8).map((event) => ({
            received_at: event.received_at,
            event_type: event.event_type,
            provider_event_id: event.provider_event_id,
        })),
        event_count: events.length,
        warnings,
        next_action: nextAction({
            status,
            providerRequestId: detail.provider_request_id,
            signedPdfImported,
            readyToDownload,
        }),
    };
}

async function printRequest(
    db: ReturnType<typeof createServerSupabase>,
    requestId: string,
): Promise<SigningStatus | null> {
    const snapshot = await loadSnapshot(db, requestId);
    if (jsonMode()) {
        console.log(JSON.stringify(snapshot, null, 2));
        return snapshot.status;
    }
    if (!snapshot.found) {
        console.log(snapshot.warnings[0] ?? `Signature request not found: ${requestId}`);
        return null;
    }

    console.log("\nMike signature request watch\n");
    console.log(`Request: ${fmt(snapshot.request_id)}`);
    console.log(`Document: ${fmt(snapshot.document_id)}`);
    console.log(`Provider: ${fmt(snapshot.provider)}`);
    console.log(`Provider request: ${fmt(snapshot.provider_request_id)}`);
    console.log(`Status: ${fmt(snapshot.status)}`);
    console.log(`Sent: ${fmt(snapshot.sent_at)}`);
    console.log(`Completed: ${fmt(snapshot.completed_at)}`);
    console.log(`Signed PDF path: ${fmt(snapshot.signed_pdf_path)}`);
    console.log(
        `Signed PDF URL: ${snapshot.signed_pdf_url_available ? "available" : "not available"}`,
    );
    console.log(`Next action: ${snapshot.next_action}`);

    console.log("\nRecipients");
    if (!snapshot.recipients.length) {
        console.log("  none recorded");
    }
    for (const recipient of snapshot.recipients) {
        const link = recipient.signing_url ?? "-";
        console.log(
            [
                `  #${fmt(recipient.signing_order)}`,
                fmt(recipient.role),
                fmt(recipient.status),
                recipient.email_masked,
                recipient.signing_url_recorded
                    ? flag("--show-links")
                        ? `link=${link}`
                        : "link=recorded"
                    : "link=-",
            ].join(" | "),
        );
    }

    console.log("\nRecent events");
    if (!snapshot.events.length) {
        console.log("  none recorded");
    }
    for (const event of snapshot.events) {
        console.log(
            `  ${fmt(event.received_at)} | ${fmt(event.event_type)} | ${fmt(event.provider_event_id)}`,
        );
    }

    for (const warning of snapshot.warnings) {
        console.log(`\nWarning: ${warning}`);
    }

    return snapshot.status;
}

async function syncProviderStatus(
    db: ReturnType<typeof createServerSupabase>,
    requestId: string,
): Promise<boolean> {
    const detail = await loadSignatureRequestDetail(db, requestId);
    if (!detail) {
        console.log(`Signature request not found: ${requestId}`);
        return false;
    }
    if (!detail.provider_request_id) {
        console.log("Provider sync skipped: request has no provider_request_id yet.");
        return false;
    }
    const provider = getSigningProvider(String(detail.provider));
    await syncSignatureRequestFromProvider({ db, requestId, provider });
    console.log("Provider status synced.");
    return true;
}

async function main(): Promise<void> {
    const db = createServerSupabase();
    const requestId = await resolveRequestId(db);
    if (!requestId) {
        console.log(
            "No signature request found. Pass --request-id, --document-id, or create a signature request first.",
        );
        process.exitCode = 1;
        return;
    }

    const watch = flag("--watch") || envFlag("SIGNATURE_WATCH");
    const sync = flag("--sync") || envFlag("SIGNATURE_SYNC_PROVIDER");
    const intervalMs = numberArg("--interval-ms", "SIGNATURE_WATCH_INTERVAL_MS", 10_000);
    const timeoutMs = numberArg("--timeout-ms", "SIGNATURE_WATCH_TIMEOUT_MS", watch ? 600_000 : 0);
    const started = Date.now();

    while (true) {
        let syncFailed = false;
        if (sync) {
            try {
                syncFailed = !(await syncProviderStatus(db, requestId));
            } catch (err) {
                syncFailed = true;
                const message = err instanceof Error ? err.message : String(err);
                console.log(`Provider sync failed: ${message}`);
            }
        }
        const status = await printRequest(db, requestId);
        if (!watch && syncFailed) {
            process.exitCode = 1;
            break;
        }
        if (!watch) break;
        if (status && TERMINAL_STATUSES.has(status)) {
            if (status === "completed") {
                const detail = await loadSignatureRequestDetail(db, requestId);
                process.exitCode = detail?.signed_pdf_path ? 0 : 1;
            } else {
                process.exitCode = 2;
            }
            break;
        }
        if (timeoutMs > 0 && Date.now() - started >= timeoutMs) {
            console.log(`\nTimed out after ${timeoutMs}ms waiting for a terminal signature status.`);
            process.exitCode = 1;
            break;
        }
        console.log(`\nWaiting ${intervalMs}ms...`);
        await sleep(intervalMs);
    }
}

main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("fetch failed")) {
        console.error(
            "Could not reach Supabase while reading signature requests. Check SUPABASE_URL, network access, and the backend service-role key.",
        );
    } else {
        console.error(message);
    }
    process.exitCode = 1;
});
