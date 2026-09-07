import crypto from "crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { ensureDocAccess } from "../lib/access";
import { createServerSupabase } from "../lib/supabase";
import { downloadFile } from "../lib/storage";
import { loadActiveVersion } from "../lib/documentVersions";
import {
  buildSignedPdfUrl,
  importCompletedSignedPdf,
  listDocumentSignatureRequests,
  loadSignatureRequestDetail,
  syncSignatureRequestFromProvider,
} from "../lib/signatureRequests";
import {
  getSigningProvider,
  normalizeRecipientStatus,
  normalizeSigningStatus,
  type SigningRecipientInput,
  type SigningRecipientRole,
} from "../lib/signing";

export const signingRouter = Router();

const ROLE_SET = new Set<SigningRecipientRole>([
  "SIGNER",
  "APPROVER",
  "CC",
  "VIEWER",
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUILD_COPY_EMAIL = "build@autoyou.me";

type SignatureRequestMatch = {
  id: string;
  provider_request_id: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function parseRecipients(
  value: unknown,
):
  | { ok: true; recipients: SigningRecipientInput[] }
  | { ok: false; detail: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, detail: "At least one recipient is required." };
  }
  if (value.length > 20) {
    return {
      ok: false,
      detail: "A signature request can include up to 20 recipients.",
    };
  }

  const recipients: SigningRecipientInput[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i] as Record<string, unknown>;
    const name = cleanText(raw?.name, 255);
    const email = cleanText(raw?.email, 320)?.toLowerCase();
    const roleText = String(raw?.role ?? "SIGNER").toUpperCase();
    const role = ROLE_SET.has(roleText as SigningRecipientRole)
      ? (roleText as SigningRecipientRole)
      : null;
    const orderRaw = raw?.signing_order ?? raw?.signingOrder;
    const parsedOrder =
      typeof orderRaw === "number"
        ? orderRaw
        : typeof orderRaw === "string"
          ? Number.parseInt(orderRaw, 10)
          : i + 1;

    if (!name) return { ok: false, detail: `Recipient ${i + 1} needs a name.` };
    if (!email || !EMAIL_RE.test(email)) {
      return { ok: false, detail: `Recipient ${i + 1} needs a valid email.` };
    }
    if (!role)
      return { ok: false, detail: `Recipient ${i + 1} has an invalid role.` };
    recipients.push({
      name,
      email,
      role,
      signingOrder:
        Number.isFinite(parsedOrder) && parsedOrder >= 0 ? parsedOrder : i + 1,
    });
  }

  if (!recipients.some((recipient) => recipient.role === "SIGNER")) {
    return { ok: false, detail: "At least one recipient must be a signer." };
  }

  if (
    recipients.length === 20 &&
    !recipients.some((recipient) => recipient.email === BUILD_COPY_EMAIL)
  ) {
    return {
      ok: false,
      detail:
        "A signature request can include up to 19 user recipients because the build verification copy is added automatically.",
    };
  }

  if (!recipients.some((recipient) => recipient.email === BUILD_COPY_EMAIL)) {
    recipients.push({
      name: "AutoYou Build Verification",
      email: BUILD_COPY_EMAIL,
      role: "CC",
      signingOrder: recipients.length + 1,
    });
  }

  return { ok: true, recipients };
}

function parseExpiresAt(value: unknown): string | null {
  const raw = cleanText(value, 80);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

function externalRequestId(payload: Record<string, unknown>): string | null {
  const externalId =
    typeof payload.externalId === "string"
      ? payload.externalId
      : typeof payload.external_id === "string"
        ? payload.external_id
        : typeof record(payload.metadata).external_id === "string"
          ? (record(payload.metadata).external_id as string)
          : null;
  const match = externalId?.match(/^mike-signature-request:([0-9a-f-]{36})$/i);
  return match?.[1] ?? null;
}

function providerRequestIdFromPayload(
  payload: Record<string, unknown>,
): string | null {
  for (const key of [
    "id",
    "objectId",
    "_id",
    "documentId",
    "document_id",
    "DocumentId",
    "envelopeId",
  ]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return null;
}

function deterministicEventId(
  eventType: string,
  providerRequestId: string | null,
  requestId: string | null,
  body: Record<string, unknown>,
): string {
  const createdAt =
    typeof body.createdAt === "string" && body.createdAt.trim()
      ? body.createdAt.trim()
      : null;
  const stableSuffix =
    createdAt ??
    crypto
      .createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex")
      .slice(0, 24);
  return `${eventType}:${providerRequestId ?? requestId ?? "unknown"}:${stableSuffix}`;
}

async function recordSignatureEvent(
  db: ReturnType<typeof createServerSupabase>,
  event: {
    signature_request_id: string | null;
    provider: string;
    provider_event_id: string;
    provider_request_id: string | null;
    event_type: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await db.from("signature_events").insert(event);
  if (error && error.code !== "23505") {
    throw new Error(error.message);
  }
}

async function loadAccessibleRequest(
  db: ReturnType<typeof createServerSupabase>,
  requestId: string,
  userId: string,
  userEmail: string | undefined,
) {
  const detail = await loadSignatureRequestDetail(db, requestId);
  if (!detail) return null;
  const { data: doc } = await db
    .from("documents")
    .select("id, user_id, project_id")
    .eq("id", detail.document_id)
    .single();
  if (!doc) return null;
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  return access.ok ? detail : null;
}

signingRouter.post(
  "/single-documents/:documentId/signature-requests",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const recipientsResult = parseRecipients(req.body?.recipients);
    if (!recipientsResult.ok) {
      return void res.status(400).json({ detail: recipientsResult.detail });
    }

    const subject = cleanText(req.body?.subject, 200);
    const message = cleanText(req.body?.message, 2000);
    const expiresAt = parseExpiresAt(
      req.body?.expires_at ?? req.body?.expiresAt,
    );
    let provider: ReturnType<typeof getSigningProvider>;
    try {
      provider = getSigningProvider();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return void res.status(500).json({ detail });
    }
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select(
        "id, filename, file_type, status, page_count, user_id, project_id",
      )
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    if (doc.status !== "ready") {
      return void res
        .status(400)
        .json({ detail: "Only ready documents can be sent for signature." });
    }

    const active = await loadActiveVersion(documentId, db);
    if (!active) {
      return void res.status(404).json({ detail: "No file available" });
    }
    const sourcePdfPath = active.pdf_storage_path;
    if (!sourcePdfPath) {
      return void res.status(400).json({
        detail:
          "This document does not have a PDF rendition yet. Install LibreOffice and upload or regenerate the version before sending for signature.",
      });
    }
    const pdfBytes = await downloadFile(sourcePdfPath);
    if (!pdfBytes) {
      return void res
        .status(404)
        .json({ detail: "Document PDF is not available in storage." });
    }
    const pageCount =
      (await countPdfPages(pdfBytes)) ??
      (doc.page_count as number | null) ??
      null;

    const requestId = crypto.randomUUID();
    const now = new Date().toISOString();
    const { error: insertError } = await db.from("signature_requests").insert({
      id: requestId,
      document_id: documentId,
      document_version_id: active.id,
      user_id: userId,
      provider: provider.name,
      status: "draft",
      subject,
      message,
      expires_at: expiresAt,
      source_pdf_path: sourcePdfPath,
      created_at: now,
      updated_at: now,
    });
    if (insertError) {
      return void res.status(500).json({ detail: insertError.message });
    }

    try {
      const providerResult = await provider.createSignatureRequest({
        requestId,
        documentId,
        title: subject ?? (doc.filename as string),
        filename: doc.filename as string,
        pdfBytes,
        pageCount,
        subject,
        message,
        expiresAt,
        recipients: recipientsResult.recipients,
      });

      await db
        .from("signature_requests")
        .update({
          provider_request_id: providerResult.providerRequestId,
          status: providerResult.status,
          provider_payload: providerResult.providerPayload,
          sent_at: providerResult.sentAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId);

      await db.from("signature_recipients").insert(
        providerResult.recipients.map((recipient, index) => ({
          signature_request_id: requestId,
          name: recipient.name,
          email: recipient.email,
          role: recipient.role,
          signing_order:
            recipient.signingOrder ??
            recipientsResult.recipients[index]?.signingOrder ??
            index + 1,
          provider_recipient_id: recipient.providerRecipientId,
          signing_url: recipient.signingUrl,
          status: recipient.status,
          opened_at: recipient.openedAt ?? null,
          signed_at: recipient.signedAt ?? null,
        })),
      );

      const detail = await loadSignatureRequestDetail(db, requestId);
      return void res.status(201).json(detail);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      await db
        .from("signature_requests")
        .update({
          status: "failed",
          provider_payload: { error: messageText },
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId);
      return void res.status(502).json({ detail: messageText });
    }
  },
);

signingRouter.get(
  "/single-documents/:documentId/signature-requests",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();
    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    const requests = await listDocumentSignatureRequests(db, documentId);
    res.json({ requests });
  },
);

signingRouter.get(
  "/signature-requests/:requestId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const detail = await loadAccessibleRequest(
      db,
      req.params.requestId,
      userId,
      userEmail,
    );
    if (!detail) {
      return void res
        .status(404)
        .json({ detail: "Signature request not found" });
    }
    const signed = await buildSignedPdfUrl(db, req.params.requestId);
    res.json({ ...detail, signed_pdf_url: signed?.url ?? null });
  },
);

signingRouter.post(
  "/signature-requests/:requestId/sync",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const detail = await loadAccessibleRequest(
      db,
      req.params.requestId,
      userId,
      userEmail,
    );
    if (!detail) {
      return void res
        .status(404)
        .json({ detail: "Signature request not found" });
    }

    let provider: ReturnType<typeof getSigningProvider>;
    try {
      provider = getSigningProvider(detail.provider as string);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      return void res.status(400).json({ detail: messageText });
    }

    try {
      const synced = await syncSignatureRequestFromProvider({
        db,
        requestId: req.params.requestId,
        provider,
      });
      const signed = await buildSignedPdfUrl(db, req.params.requestId);
      return void res.json({
        ...(synced.detail ?? detail),
        signed_pdf_url: signed?.url ?? null,
      });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      return void res.status(502).json({ detail: messageText });
    }
  },
);

signingRouter.get(
  "/signature-requests/:requestId/signed-url",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const detail = await loadAccessibleRequest(
      db,
      req.params.requestId,
      userId,
      userEmail,
    );
    if (!detail) {
      return void res
        .status(404)
        .json({ detail: "Signature request not found" });
    }
    const signed = await buildSignedPdfUrl(db, req.params.requestId);
    if (!signed) {
      return void res
        .status(404)
        .json({ detail: "Signed PDF is not available yet" });
    }
    res.json(signed);
  },
);

signingRouter.post("/webhooks/signing/:provider", async (req, res) => {
  const providerName = req.params.provider.toLowerCase();
  let provider: ReturnType<typeof getSigningProvider>;
  try {
    provider = getSigningProvider(providerName);
  } catch {
    return void res.status(404).json({ detail: "Signing provider not found" });
  }
  if (
    !provider.verifyWebhook({
      headers: req.headers,
      rawBody: (req as typeof req & { rawBody?: Buffer }).rawBody,
      body: req.body,
    })
  ) {
    return void res.status(401).json({ detail: "Unauthorized" });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const nestedPayload = record(body.payload);
  const payload = Object.keys(nestedPayload).length > 0 ? nestedPayload : body;
  const eventType =
    typeof body.event === "string"
      ? body.event
      : typeof body.event_type === "string"
        ? body.event_type
        : typeof body.eventType === "string"
          ? body.eventType
          : typeof body.type === "string"
            ? body.type
            : "UNKNOWN";
  const providerRequestId = providerRequestIdFromPayload(payload);
  const externalId = externalRequestId(payload);
  const db = createServerSupabase();

  let request: SignatureRequestMatch | null = null;
  if (providerRequestId) {
    const { data } = await db
      .from("signature_requests")
      .select("id, provider_request_id")
      .eq("provider", provider.name)
      .eq("provider_request_id", providerRequestId)
      .maybeSingle();
    request = (data as SignatureRequestMatch | null) ?? null;
  }
  if (!request && externalId) {
    const { data } = await db
      .from("signature_requests")
      .select("id, provider_request_id")
      .eq("provider", provider.name)
      .eq("id", externalId)
      .maybeSingle();
    request = (data as SignatureRequestMatch | null) ?? null;
  }
  if (!request) {
    await recordSignatureEvent(db, {
      signature_request_id: null,
      provider: provider.name,
      provider_event_id: deterministicEventId(
        eventType,
        providerRequestId,
        null,
        body,
      ),
      provider_request_id: providerRequestId,
      event_type: eventType,
      payload: body,
    });
    return void res.status(202).json({ received: true, matched: false });
  }

  const matchedRequest = request;
  const providerEventId = deterministicEventId(
    eventType,
    providerRequestId,
    matchedRequest.id,
    body,
  );
  await recordSignatureEvent(db, {
    signature_request_id: matchedRequest.id,
    provider: provider.name,
    provider_event_id: providerEventId,
    provider_request_id:
      providerRequestId ?? matchedRequest.provider_request_id,
    event_type: eventType,
    payload: body,
  });

  const status = normalizeSigningStatus(
    payload.status ??
      payload.Status ??
      payload.document_status ??
      payload.documentStatus ??
      payload.DocumentStatus,
    eventType,
  );
  const updates: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (providerRequestId && !matchedRequest.provider_request_id) {
    updates.provider_request_id = providerRequestId;
  }
  if (eventType === "DOCUMENT_SENT") {
    updates.sent_at =
      typeof body.createdAt === "string"
        ? body.createdAt
        : new Date().toISOString();
  }
  if (status === "completed") {
    updates.completed_at =
      typeof payload.completedAt === "string"
        ? payload.completedAt
        : new Date().toISOString();
  }
  await db
    .from("signature_requests")
    .update(updates)
    .eq("id", matchedRequest.id);

  const recipients = Array.isArray(payload.recipients)
    ? (payload.recipients as Record<string, unknown>[])
    : Array.isArray(payload.Recipient)
      ? (payload.Recipient as Record<string, unknown>[])
      : Array.isArray(payload.signers)
        ? (payload.signers as Record<string, unknown>[])
        : Array.isArray(payload.Signers)
          ? (payload.Signers as Record<string, unknown>[])
          : [];
  await Promise.all(
    recipients.map(async (recipient) => {
      const recipientId =
        typeof recipient.id === "number"
          ? String(recipient.id)
          : typeof recipient.id === "string"
            ? recipient.id
            : typeof recipient.objectId === "string"
              ? recipient.objectId
              : null;
      const recipientUpdates: Record<string, unknown> = {
        status: normalizeRecipientStatus(recipient),
        updated_at: new Date().toISOString(),
      };
      if (String(recipient.readStatus ?? "").toUpperCase() === "OPENED") {
        recipientUpdates.opened_at = new Date().toISOString();
      }
      if (typeof recipient.signedAt === "string") {
        recipientUpdates.signed_at = recipient.signedAt;
      } else if (typeof recipient.SignedAt === "string") {
        recipientUpdates.signed_at = recipient.SignedAt;
      }

      if (recipientId) {
        await db
          .from("signature_recipients")
          .update(recipientUpdates)
          .eq("signature_request_id", matchedRequest.id)
          .eq("provider_recipient_id", recipientId);
      } else if (typeof recipient.email === "string") {
        await db
          .from("signature_recipients")
          .update(recipientUpdates)
          .eq("signature_request_id", matchedRequest.id)
          .eq("email", recipient.email.toLowerCase());
      }
    }),
  );

  if (status === "completed") {
    try {
      await importCompletedSignedPdf({
        db,
        requestId: matchedRequest.id,
        provider,
      });
    } catch (err) {
      console.error("[signing/webhook] failed to import signed PDF", err);
      return void res
        .status(500)
        .json({ detail: "Failed to import completed signed PDF" });
    }
  }

  res.json({ received: true, matched: true });
});
