import "dotenv/config";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { getSigningProvider } from "../lib/signing";
import {
    isOpenSignWebhookSecretRequired,
    openSignApiMode,
} from "../lib/signing/opensign";

type Mode = "dry-run" | "send" | "download";

const args = process.argv.slice(2);

function env(name: string): string {
    return process.env[name]?.trim() ?? "";
}

function argValue(flag: string): string | null {
    const index = args.indexOf(flag);
    if (index < 0) return null;
    return args[index + 1]?.trim() || null;
}

function mode(): Mode {
    if (args.includes("--send") || env("LIVE_SIGNING_SEND") === "true") {
        return "send";
    }
    if (args.includes("--download") || env("LIVE_SIGNING_PROVIDER_REQUEST_ID")) {
        return "download";
    }
    return "dry-run";
}

function isEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function envTruthy(name: string): boolean {
    return ["1", "true", "yes", "on"].includes(env(name).toLowerCase());
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function emailResultRows(value: unknown): Record<string, unknown>[] {
    const rows = record(value).emailResults;
    return Array.isArray(rows)
        ? rows.filter(
              (row): row is Record<string, unknown> =>
                  row !== null && typeof row === "object" && !Array.isArray(row),
          )
        : [];
}

function emailDeliverySucceeded(rows: Record<string, unknown>[]): boolean {
    return rows.length > 0 && rows.every((row) => String(row.status ?? "") === "success");
}

function envAny(names: string[]): string {
    for (const name of names) {
        const value = env(name);
        if (value) return value;
    }
    return "";
}

function publicMikeApiBaseUrl(): string {
    return envAny([
        "MIKE_PUBLIC_API_BASE_URL",
        "PUBLIC_API_BASE_URL",
        "BACKEND_PUBLIC_URL",
        "API_PUBLIC_URL",
    ]).replace(/\/+$/, "");
}

function isLocalUrl(value: string): boolean {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(
        value,
    );
}

function isPublicHttpsUrl(value: string): boolean {
    return /^https:\/\//i.test(value) && !isLocalUrl(value);
}

function webhookTarget(): string {
    const base = publicMikeApiBaseUrl();
    return base ? `${base}/webhooks/signing/opensign` : "";
}

function liveSendIssues(): string[] {
    const issues: string[] = [];
    const email = env("LIVE_SIGNING_TEST_EMAIL");

    if (openSignApiMode() !== "selfhost" && !env("OPENSIGN_API_TOKEN")) {
        issues.push("OPENSIGN_API_TOKEN");
    }
    if (!email) {
        issues.push("LIVE_SIGNING_TEST_EMAIL");
    } else if (!isEmail(email)) {
        issues.push("LIVE_SIGNING_TEST_EMAIL(valid email)");
    }

    if (isOpenSignWebhookSecretRequired()) {
        const publicBase = publicMikeApiBaseUrl();
        if (!env("OPENSIGN_WEBHOOK_SECRET")) {
            issues.push("OPENSIGN_WEBHOOK_SECRET");
        }
        if (!publicBase) {
            issues.push("MIKE_PUBLIC_API_BASE_URL");
        } else if (!isPublicHttpsUrl(publicBase)) {
            issues.push("MIKE_PUBLIC_API_BASE_URL(public HTTPS non-local URL)");
        }
    }

    return issues;
}

function assertLiveSendReady(): void {
    const issues = liveSendIssues();
    if (issues.length === 0) return;
    throw new Error(
        [
            "Refusing to send a live OpenSign probe because the live-send gate is not ready.",
            `Missing/unsafe: ${issues.join(", ")}`,
            "Run `npm run integration:live-preflight --prefix backend` before public/live sending.",
        ].join("\n"),
    );
}

async function buildProbePdf(): Promise<Buffer> {
    const issued = new Date().toISOString();
    const lines = [
        { text: "MIKE / OPENSIGN LIVE PROBE", size: 18, x: 72, y: 720 },
        { text: `Issued: ${issued}`, size: 11, x: 72, y: 690 },
        {
            text: "Purpose: validate public signer routing and signed-PDF generation.",
            size: 11,
            x: 72,
            y: 668,
        },
        { text: "Signature Page", size: 14, x: 72, y: 620 },
        { text: "Signer: ______________________________", size: 12, x: 72, y: 572 },
        { text: "Date: _________________________________", size: 12, x: 72, y: 530 },
    ];
    const content = [
        "BT",
        ...lines.flatMap((line) => [
            `/F1 ${line.size} Tf`,
            `${line.x} ${line.y} Td`,
            `(${escapePdfText(line.text)}) Tj`,
            `${-line.x} ${-line.y} Td`,
        ]),
        "ET",
        "",
    ].join("\n");
    const stream = Buffer.from(content, "ascii");
    return buildPlainPdf(stream);
}

function escapePdfText(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPlainPdf(contentStream: Buffer): Buffer {
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${contentStream.byteLength} >>\nstream\n${contentStream.toString("ascii")}endstream`,
    ];

    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.concat(chunks).byteLength);
        chunks.push(Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "ascii"));
    }

    const xrefOffset = Buffer.concat(chunks).byteLength;
    const xref = [
        "xref",
        `0 ${objects.length + 1}`,
        "0000000000 65535 f ",
        ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n `),
        "trailer",
        `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
        "startxref",
        String(xrefOffset),
        "%%EOF",
        "",
    ].join("\n");
    chunks.push(Buffer.from(xref, "ascii"));
    return Buffer.concat(chunks);
}

async function writeProbePdf(bytes: Buffer): Promise<string> {
    const dir = path.join(os.tmpdir(), "mike-opensign-live");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "opensign-live-probe.pdf");
    await fs.writeFile(file, bytes);
    return file;
}

function requireOpenSignToken(): void {
    if (openSignApiMode() !== "selfhost" && !env("OPENSIGN_API_TOKEN")) {
        throw new Error(
            "OPENSIGN_API_TOKEN is required. OpenSign free self-hosted deployments do not generate API tokens; use a sandbox/live token or paid self-hosted API access.",
        );
    }
}

async function dryRun(): Promise<void> {
    const bytes = await buildProbePdf();
    const file = await writeProbePdf(bytes);
    const issues = liveSendIssues();
    const publicBase = publicMikeApiBaseUrl();
    const target = webhookTarget();
    const webhookRequired = isOpenSignWebhookSecretRequired();
    const publicWebhookReady =
        !!env("OPENSIGN_WEBHOOK_SECRET") &&
        !!publicBase &&
        isPublicHttpsUrl(publicBase);

    console.log("\nMike OpenSign live loop dry-run\n");
    console.log(`Probe PDF: ${file}`);
    console.log(`OpenSign mode: ${openSignApiMode()}`);
    console.log(
        `OpenSign API base: ${
            openSignApiMode() === "selfhost"
                ? env("OPENSIGN_PARSE_BASE_URL") || env("OPENSIGN_SELFHOST_API_BASE_URL") || "http://127.0.0.1:3051/api/app"
                : env("OPENSIGN_API_BASE_URL") || "https://sandbox.opensignlabs.com/api/v1.2"
        }`,
    );
    console.log(`Webhook secret: ${env("OPENSIGN_WEBHOOK_SECRET") ? "configured" : "not configured"}`);
    console.log(`Public webhook required: ${webhookRequired ? "yes" : "no"}`);
    console.log(`Mike public API base: ${publicBase || "(not configured)"}`);
    console.log(`OpenSign webhook target: ${target || "(not derivable)"}`);
    console.log(
        `Public webhook ready: ${
            publicWebhookReady ? "yes" : webhookRequired ? "no" : "not enforced"
        }`,
    );

    if (issues.length) {
        console.log(`Missing/unsafe for live send: ${issues.join(", ")}`);
        console.log(
            "Next: set the missing env vars, run `npm run integration:live-preflight --prefix backend`, then set LIVE_SIGNING_SEND=true and run `npm run integration:opensign-live --prefix backend`.",
        );
        process.exitCode = 1;
        return;
    }
    console.log(
        "Ready to send. Set LIVE_SIGNING_SEND=true and run `npm run integration:opensign-live --prefix backend` when you want to send one probe signature request.",
    );
}

async function send(): Promise<void> {
    assertLiveSendReady();
    requireOpenSignToken();
    const email = env("LIVE_SIGNING_TEST_EMAIL");
    if (!isEmail(email)) {
        throw new Error("LIVE_SIGNING_TEST_EMAIL must be set to the test recipient email.");
    }
    const name = env("LIVE_SIGNING_TEST_NAME") || "Mike Test Signer";
    const subject =
        env("LIVE_SIGNING_TEST_SUBJECT") ||
        `Mike OpenSign live probe ${new Date().toISOString()}`;
    const requestId = crypto.randomUUID();
    const bytes = await buildProbePdf();
    const file = await writeProbePdf(bytes);
    const provider = getSigningProvider("opensign");

    console.log("\nSending Mike OpenSign live probe\n");
    console.log(`Recipient: ${name} <${email}>`);
    console.log(`Probe PDF: ${file}`);

    const result = await provider.createSignatureRequest({
        requestId,
        documentId: "mike-live-probe",
        title: subject,
        filename: "mike-opensign-live-probe.pdf",
        pdfBytes: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        pageCount: 1,
        subject,
        message:
            "This is a controlled Mike/OpenSign integration probe. It is safe to ignore after testing.",
        expiresAt: null,
        recipients: [
            {
                name,
                email,
                role: "SIGNER",
                signingOrder: 1,
            },
        ],
    });

    console.log("\nOpenSign send result\n");
    console.log(`Provider request id: ${result.providerRequestId}`);
    console.log(`Status: ${result.status}`);
    for (const recipient of result.recipients) {
        console.log(
            `Recipient: ${recipient.email} status=${recipient.status} signingUrl=${recipient.signingUrl ?? "(not returned)"}`,
        );
    }
    const emailResults = emailResultRows(result.providerPayload);
    if (emailResults.length > 0) {
        for (const row of emailResults) {
            console.log(
                `Email delivery: ${String(row.email ?? "(unknown)")} status=${String(row.status ?? "unknown")}`,
            );
        }
        if (envTruthy("LIVE_SIGNING_REQUIRE_EMAIL") && !emailDeliverySucceeded(emailResults)) {
            throw new Error(
                "OpenSign created the signature request, but email delivery did not report success.",
            );
        }
    } else if (openSignApiMode() === "selfhost") {
        console.log(
            "Email delivery: not reported by OpenSign self-host provider. Check OpenSign SMTP/Mailgun settings if no message arrives.",
        );
        if (envTruthy("LIVE_SIGNING_REQUIRE_EMAIL")) {
            throw new Error(
                "OpenSign created the signature request, but email delivery was not reported.",
            );
        }
    }
    console.log(
        `\nAfter signing is completed, set LIVE_SIGNING_PROVIDER_REQUEST_ID=${result.providerRequestId} and run: npm run integration:opensign-live --prefix backend`,
    );
}

async function download(): Promise<void> {
    requireOpenSignToken();
    const providerRequestId =
        argValue("--download") || env("LIVE_SIGNING_PROVIDER_REQUEST_ID");
    if (!providerRequestId) {
        throw new Error(
            "Pass --download <providerRequestId> or set LIVE_SIGNING_PROVIDER_REQUEST_ID.",
        );
    }
    const provider = getSigningProvider("opensign");
    const signed = await provider.downloadSignedPdf(providerRequestId);
    const dir = path.join(os.tmpdir(), "mike-opensign-live");
    await fs.mkdir(dir, { recursive: true });
    const safe = signed.filename.replace(/[^\w .-]/g, "_");
    const file = path.join(dir, safe);
    await fs.writeFile(file, signed.bytes);
    console.log("\nOpenSign signed PDF download\n");
    console.log(`Provider request id: ${providerRequestId}`);
    console.log(`Signed PDF: ${file}`);
    console.log(`Bytes: ${signed.bytes.byteLength}`);
}

async function main(): Promise<void> {
    const selected = mode();
    if (selected === "send") await send();
    else if (selected === "download") await download();
    else await dryRun();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
