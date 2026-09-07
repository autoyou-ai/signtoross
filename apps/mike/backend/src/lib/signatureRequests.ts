import crypto from "crypto";
import type { createServerSupabase } from "./supabase";
import { getSignedUrl, uploadFile } from "./storage";
import type { SigningStatus } from "./signing";
import type {
  SigningProvider,
  SigningRecipientInput,
  SigningRecipientRole,
} from "./signing/types";

type Supa = ReturnType<typeof createServerSupabase>;

const TERMINAL_SIGNATURE_STATUSES = new Set<SigningStatus>([
  "completed",
  "declined",
  "expired",
  "cancelled",
  "failed",
]);

const SIGNING_RECIPIENT_ROLES = new Set<SigningRecipientRole>([
  "SIGNER",
  "APPROVER",
  "CC",
  "VIEWER",
]);

export interface LatestSignatureRequest {
  id: string;
  status: SigningStatus;
  provider: string;
  provider_request_id: string | null;
  sent_at: string | null;
  completed_at: string | null;
  signed_pdf_path: string | null;
}

interface DocWithSignature {
  id: string;
  latest_signature_request?: LatestSignatureRequest | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recipientRole(value: unknown): SigningRecipientRole {
  const role = String(value ?? "SIGNER").toUpperCase();
  return SIGNING_RECIPIENT_ROLES.has(role as SigningRecipientRole)
    ? (role as SigningRecipientRole)
    : "SIGNER";
}

function preserveTerminalStatus(
  current: SigningStatus,
  next: SigningStatus,
): SigningStatus {
  if (current === "completed") return "completed";
  if (
    TERMINAL_SIGNATURE_STATUSES.has(current) &&
    !TERMINAL_SIGNATURE_STATUSES.has(next)
  ) {
    return current;
  }
  return next;
}

function deterministicSyncEventId(args: {
  provider: string;
  providerRequestId: string;
  payload: unknown;
}): string {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(args.payload ?? {}))
    .digest("hex")
    .slice(0, 24);
  return `provider-sync:${args.provider}:${args.providerRequestId}:${digest}`;
}

function fallbackRecipientsFromRows(rows: unknown[]): SigningRecipientInput[] {
  return rows.map((row, index) => {
    const recipient = record(row);
    const order =
      typeof recipient.signing_order === "number"
        ? recipient.signing_order
        : Number.parseInt(String(recipient.signing_order ?? index + 1), 10);
    return {
      name: text(recipient.name) ?? `Signer ${index + 1}`,
      email: text(recipient.email) ?? `signer-${index + 1}@example.invalid`,
      role: recipientRole(recipient.role),
      signingOrder: Number.isFinite(order) ? order : index + 1,
    };
  });
}

export async function attachLatestSignatureRequests<T extends DocWithSignature>(
  db: Supa,
  docs: T[],
): Promise<T[]> {
  if (docs.length === 0) return docs;
  const ids = docs.map((doc) => doc.id);
  const { data } = await db
    .from("signature_requests")
    .select(
      "id, document_id, status, provider, provider_request_id, sent_at, completed_at, signed_pdf_path, created_at",
    )
    .in("document_id", ids)
    .order("created_at", { ascending: false });

  const latestByDoc = new Map<string, LatestSignatureRequest>();
  for (const row of (data ?? []) as (LatestSignatureRequest & {
    document_id: string;
  })[]) {
    if (!latestByDoc.has(row.document_id)) {
      latestByDoc.set(row.document_id, {
        id: row.id,
        status: row.status,
        provider: row.provider,
        provider_request_id: row.provider_request_id,
        sent_at: row.sent_at,
        completed_at: row.completed_at,
        signed_pdf_path: row.signed_pdf_path,
      });
    }
  }

  for (const doc of docs) {
    doc.latest_signature_request = latestByDoc.get(doc.id) ?? null;
  }
  return docs;
}

export async function loadSignatureRequestDetail(
  db: Supa,
  requestId: string,
) {
  const { data: request } = await db
    .from("signature_requests")
    .select("*")
    .eq("id", requestId)
    .single();
  if (!request) return null;

  const [{ data: recipients }, { data: events }] = await Promise.all([
    db
      .from("signature_recipients")
      .select("*")
      .eq("signature_request_id", requestId)
      .order("signing_order", { ascending: true }),
    db
      .from("signature_events")
      .select("id, event_type, provider_event_id, received_at, payload")
      .eq("signature_request_id", requestId)
      .order("received_at", { ascending: false }),
  ]);

  return {
    ...request,
    recipients: recipients ?? [],
    events: events ?? [],
  };
}

export async function listDocumentSignatureRequests(
  db: Supa,
  documentId: string,
) {
  const { data: requests } = await db
    .from("signature_requests")
    .select("*")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });

  const ids = (requests ?? []).map((request) => request.id as string);
  const recipientsByRequest = new Map<string, unknown[]>();
  if (ids.length > 0) {
    const { data: recipients } = await db
      .from("signature_recipients")
      .select("*")
      .in("signature_request_id", ids)
      .order("signing_order", { ascending: true });
    for (const recipient of recipients ?? []) {
      const requestId = recipient.signature_request_id as string;
      const list = recipientsByRequest.get(requestId) ?? [];
      list.push(recipient);
      recipientsByRequest.set(requestId, list);
    }
  }

  return (requests ?? []).map((request) => ({
    ...request,
    recipients: recipientsByRequest.get(request.id as string) ?? [],
  }));
}

export async function syncSignatureRequestFromProvider(args: {
  db: Supa;
  requestId: string;
  provider: SigningProvider;
}) {
  const { db, requestId, provider } = args;
  if (!provider.getSignatureRequestStatus) {
    throw new Error(`${provider.name} does not support status sync`);
  }

  const detail = await loadSignatureRequestDetail(db, requestId);
  if (!detail) throw new Error("Signature request not found");
  if (detail.provider !== provider.name) {
    throw new Error(
      `Signature request uses provider ${detail.provider}, not ${provider.name}`,
    );
  }
  const providerRequestId = text(detail.provider_request_id);
  if (!providerRequestId) {
    throw new Error("Signature request does not have a provider request id yet");
  }

  const recipients = Array.isArray(detail.recipients)
    ? fallbackRecipientsFromRows(detail.recipients)
    : [];
  const providerStatus = await provider.getSignatureRequestStatus(
    providerRequestId,
    recipients,
  );
  const now = new Date().toISOString();
  const nextStatus = preserveTerminalStatus(
    detail.status as SigningStatus,
    providerStatus.status,
  );
  const priorPayload = record(detail.provider_payload);
  const updates: Record<string, unknown> = {
    provider_request_id: providerStatus.providerRequestId,
    status: nextStatus,
    provider_payload: {
      ...priorPayload,
      last_status_sync: providerStatus.providerPayload,
    },
    updated_at: now,
  };
  if (!detail.sent_at && providerStatus.sentAt) {
    updates.sent_at = providerStatus.sentAt;
  }
  if (nextStatus === "completed") {
    updates.completed_at =
      providerStatus.completedAt ?? (detail.completed_at as string | null) ?? now;
  }

  const { error: updateError } = await db
    .from("signature_requests")
    .update(updates)
    .eq("id", requestId);
  if (updateError) throw new Error(updateError.message);

  await Promise.all(
    providerStatus.recipients.map(async (recipient) => {
      const recipientUpdates: Record<string, unknown> = {
        status: recipient.status,
        updated_at: now,
      };
      if (recipient.providerRecipientId) {
        recipientUpdates.provider_recipient_id = recipient.providerRecipientId;
      }
      if (recipient.signingUrl) recipientUpdates.signing_url = recipient.signingUrl;
      if (recipient.openedAt) recipientUpdates.opened_at = recipient.openedAt;
      if (recipient.signedAt) recipientUpdates.signed_at = recipient.signedAt;

      if (recipient.providerRecipientId) {
        await db
          .from("signature_recipients")
          .update(recipientUpdates)
          .eq("signature_request_id", requestId)
          .eq("provider_recipient_id", recipient.providerRecipientId);
      } else {
        await db
          .from("signature_recipients")
          .update(recipientUpdates)
          .eq("signature_request_id", requestId)
          .eq("email", recipient.email.toLowerCase());
      }
    }),
  );

  const { error: eventError } = await db.from("signature_events").insert({
    signature_request_id: requestId,
    provider: provider.name,
    provider_event_id: deterministicSyncEventId({
      provider: provider.name,
      providerRequestId: providerStatus.providerRequestId,
      payload: providerStatus.providerPayload,
    }),
    provider_request_id: providerStatus.providerRequestId,
    event_type: "PROVIDER_STATUS_SYNC",
    payload: providerStatus.providerPayload,
    received_at: now,
  });
  if (eventError && eventError.code !== "23505") {
    throw new Error(eventError.message);
  }

  let importedSignedPdfPath: string | null = null;
  if (nextStatus === "completed") {
    importedSignedPdfPath = await importCompletedSignedPdf({
      db,
      requestId,
      provider,
    });
  }

  return {
    detail: await loadSignatureRequestDetail(db, requestId),
    providerStatus,
    importedSignedPdfPath,
  };
}

export function signedPdfStorageKey(
  userId: string,
  documentId: string,
  requestId: string,
): string {
  return `documents/${userId}/${documentId}/signed/${requestId}.pdf`;
}

export function signedPdfFilename(filename: string): string {
  if (/\[Signed\]\.pdf$/i.test(filename)) return filename;
  const stem = filename.replace(/\.[a-z0-9]{1,16}$/i, "") || "document";
  return `${stem} [Signed].pdf`;
}

export async function buildSignedPdfUrl(
  db: Supa,
  requestId: string,
): Promise<{ url: string; filename: string } | null> {
  const { data: request } = await db
    .from("signature_requests")
    .select("id, document_id, signed_pdf_path")
    .eq("id", requestId)
    .single();
  if (!request?.signed_pdf_path) return null;

  const { data: doc } = await db
    .from("documents")
    .select("filename")
    .eq("id", request.document_id)
    .single();
  const filename = signedPdfFilename((doc?.filename as string) ?? "document.pdf");
  const url = await getSignedUrl(request.signed_pdf_path as string, 3600, filename);
  return url ? { url, filename } : null;
}

export async function importCompletedSignedPdf(args: {
  db: Supa;
  requestId: string;
  provider: SigningProvider;
}): Promise<string | null> {
  const { db, requestId, provider } = args;
  const { data: request } = await db
    .from("signature_requests")
    .select(
      "id, document_id, document_version_id, user_id, provider_request_id, signed_pdf_path",
    )
    .eq("id", requestId)
    .single();
  if (!request?.provider_request_id) return null;
  if (request.signed_pdf_path) return request.signed_pdf_path as string;

  const { data: doc } = await db
    .from("documents")
    .select("filename")
    .eq("id", request.document_id)
    .single();
  const signed = await provider.downloadSignedPdf(
    request.provider_request_id as string,
  );
  const displayName = signedPdfFilename(
    (doc?.filename as string) ?? signed.filename,
  );
  const key = signedPdfStorageKey(
    request.user_id as string,
    request.document_id as string,
    request.id as string,
  );
  await uploadFile(
    key,
    signed.bytes.buffer.slice(
      signed.bytes.byteOffset,
      signed.bytes.byteOffset + signed.bytes.byteLength,
    ) as ArrayBuffer,
    "application/pdf",
  );

  const { data: maxRow } = await db
    .from("document_versions")
    .select("version_number")
    .eq("document_id", request.document_id)
    .not("version_number", "is", null)
    .order("version_number", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const nextVersionNumber =
    ((maxRow?.version_number as number | null) ?? 1) + 1;

  const { data: versionRow, error: versionError } = await db
    .from("document_versions")
    .insert({
      document_id: request.document_id,
      storage_path: key,
      pdf_storage_path: key,
      source: "signed",
      version_number: nextVersionNumber,
      display_name: displayName,
    })
    .select("id")
    .single();
  if (versionError || !versionRow) {
    throw new Error(
      `Failed to record signed document version: ${
        versionError?.message ?? "unknown"
      }`,
    );
  }

  await db
    .from("documents")
    .update({
      current_version_id: versionRow.id,
      filename: displayName,
      file_type: "pdf",
      size_bytes: signed.bytes.byteLength,
      updated_at: new Date().toISOString(),
    })
    .eq("id", request.document_id);

  await db
    .from("signature_requests")
    .update({
      signed_pdf_path: key,
      status: "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  return key;
}
