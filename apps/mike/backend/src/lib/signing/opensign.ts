import crypto from "crypto";
import {
  normalizeRecipientStatus,
  normalizeSigningStatus,
  type ProviderCreateResult,
  type ProviderRecipientResult,
  type ProviderStatusResult,
  type SignedPdfResult,
  type SigningCreateInput,
  type SigningProvider,
  type SigningRecipientInput,
} from "./types";

type JsonRecord = Record<string, unknown>;

const DEFAULT_API_BASE = "https://sandbox.opensignlabs.com/api/v1.2";
const DEFAULT_PARSE_BASE = "http://127.0.0.1:3051/api/app";
const DEFAULT_PUBLIC_URL = "http://127.0.0.1:3051";
const DEFAULT_PARSE_APP_ID = "opensign";
const PUBLIC_REPLY_TO = "build@autoyou.me";

type OpenSignApiMode = "token" | "selfhost";

type ParseSession = {
  email: string;
  password: string;
  sessionToken: string;
  userId: string;
  createdAt: number;
};

let parseSessionCache: ParseSession | null = null;

function apiBase(): string {
  return (process.env.OPENSIGN_API_BASE_URL ?? DEFAULT_API_BASE).replace(
    /\/+$/,
    "",
  );
}

export function openSignApiMode(): OpenSignApiMode {
  const mode = process.env.OPENSIGN_API_MODE?.trim().toLowerCase();
  if (["selfhost", "self-host", "parse", "local"].includes(mode ?? "")) {
    return "selfhost";
  }
  if (!process.env.OPENSIGN_API_TOKEN?.trim()) {
    const hasSelfHostConfig =
      process.env.OPENSIGN_PARSE_MASTER_KEY?.trim() &&
      process.env.OPENSIGN_ADMIN_EMAIL?.trim() &&
      process.env.OPENSIGN_ADMIN_PASSWORD?.trim();
    if (hasSelfHostConfig) return "selfhost";
  }
  return "token";
}

export function isOpenSignConfigured(): boolean {
  if (openSignApiMode() === "selfhost") {
    return Boolean(
      process.env.OPENSIGN_PARSE_MASTER_KEY?.trim() &&
      process.env.OPENSIGN_ADMIN_EMAIL?.trim() &&
      process.env.OPENSIGN_ADMIN_PASSWORD?.trim(),
    );
  }
  return Boolean(process.env.OPENSIGN_API_TOKEN?.trim());
}

function apiToken(): string {
  const token = process.env.OPENSIGN_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "OPENSIGN_API_TOKEN is required to send signature requests",
    );
  }
  return token;
}

function parseBase(): string {
  return (
    process.env.OPENSIGN_PARSE_BASE_URL?.trim() ??
    process.env.OPENSIGN_SELFHOST_API_BASE_URL?.trim() ??
    DEFAULT_PARSE_BASE
  ).replace(/\/+$/, "");
}

function openSignPublicUrl(): string {
  return (
    process.env.OPENSIGN_PUBLIC_URL?.trim() ??
    process.env.OPENSIGN_SELFHOST_PUBLIC_URL?.trim() ??
    DEFAULT_PUBLIC_URL
  ).replace(/\/+$/, "");
}

function parseAppId(): string {
  return process.env.OPENSIGN_PARSE_APP_ID?.trim() || DEFAULT_PARSE_APP_ID;
}

function parseMasterKey(): string {
  const value = process.env.OPENSIGN_PARSE_MASTER_KEY?.trim();
  if (!value) {
    throw new Error(
      "OPENSIGN_PARSE_MASTER_KEY is required for OPENSIGN_API_MODE=selfhost",
    );
  }
  return value;
}

function parseAdminEmail(): string {
  const value = process.env.OPENSIGN_ADMIN_EMAIL?.trim();
  if (!value) {
    throw new Error(
      "OPENSIGN_ADMIN_EMAIL is required for OPENSIGN_API_MODE=selfhost",
    );
  }
  return value;
}

function parseAdminPassword(): string {
  const value = process.env.OPENSIGN_ADMIN_PASSWORD?.trim();
  if (!value) {
    throw new Error(
      "OPENSIGN_ADMIN_PASSWORD is required for OPENSIGN_API_MODE=selfhost",
    );
  }
  return value;
}

function parseHostHeader(): string | null {
  const explicit = process.env.OPENSIGN_PARSE_HOST_HEADER?.trim();
  if (explicit) return explicit;
  try {
    return new URL(openSignPublicUrl()).host;
  } catch {
    return null;
  }
}

function parseHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  const host = parseHostHeader();
  return {
    "X-Parse-Application-Id": parseAppId(),
    ...(host ? { Host: host } : {}),
    ...extra,
  };
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `${response.status} ${response.statusText}`;
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? text;
  } catch {
    return text;
  }
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "x-api-token": apiToken(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) {
    throw new Error(`OpenSign ${path} failed: ${await readError(response)}`);
  }
  if (response.status === 204) return null;
  return response.json().catch(() => null) as Promise<unknown>;
}

async function requestParseJson(
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetch(`${parseBase()}${path}`, init);
  if (!response.ok) {
    throw new Error(
      `OpenSign Parse ${path} failed: ${await readError(response)}`,
    );
  }
  if (response.status === 204) return null;
  return response.json().catch(() => null) as Promise<unknown>;
}

async function requestParseFunction(
  name: string,
  params: JsonRecord,
): Promise<unknown> {
  return requestParseJson(`/functions/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: parseHeaders({
      "X-Parse-Master-Key": parseMasterKey(),
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(params),
  });
}

async function parseLogin(): Promise<ParseSession> {
  const email = parseAdminEmail();
  const password = parseAdminPassword();
  if (
    parseSessionCache &&
    parseSessionCache.email === email &&
    parseSessionCache.password === password &&
    Date.now() - parseSessionCache.createdAt < 30 * 60 * 1000
  ) {
    return parseSessionCache;
  }

  const response = record(
    await requestParseJson("/login", {
      method: "POST",
      headers: parseHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ username: email, password }),
    }),
  );
  const sessionToken = getString(response.sessionToken);
  const userId = getIdentifier(response.objectId);
  if (!sessionToken || !userId) {
    throw new Error("OpenSign Parse login did not return a session token");
  }
  parseSessionCache = {
    email,
    password,
    sessionToken,
    userId,
    createdAt: Date.now(),
  };
  return parseSessionCache;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayFrom(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter(Boolean) : [];
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getIdentifier(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function unwrap(value: unknown): JsonRecord {
  const root = record(value);
  for (const key of ["data", "result", "document", "Document"]) {
    const nested = record(root[key]);
    if (Object.keys(nested).length > 0) return nested;
  }
  return root;
}

function pdfFilename(filename: string): string {
  if (/\.pdf$/i.test(filename)) return filename;
  const stem = filename.replace(/\.[a-z0-9]{1,16}$/i, "") || "document";
  return `${stem}.pdf`;
}

function safeFilename(filename: string): string {
  return pdfFilename(filename)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

function toOpenSignSignerRole(role: SigningRecipientInput["role"]): string {
  if (role === "VIEWER" || role === "CC") return "viewer";
  if (role === "APPROVER") return "approver";
  return "signer";
}

function signerRoleName(index: number): string {
  return `Signer ${index + 1}`;
}

function buildSignerWidgets(
  index: number,
  pageCount: number | null,
): JsonRecord[] {
  const page = Math.max(1, pageCount ?? 1);
  const y = Math.max(96, 628 - index * 44);
  const role = signerRoleName(index);
  return [
    {
      type: "signature",
      page,
      x: 72,
      y,
      w: 160,
      h: 32,
      signer: role,
      role,
      options: {
        required: true,
        name: `signature_${index + 1}`,
        hint: "Provide signature",
      },
    },
    {
      type: "name",
      page,
      x: 72,
      y: y - 28,
      w: 160,
      h: 24,
      signer: role,
      role,
      options: {
        required: true,
        name: `name_${index + 1}`,
        fontsize: 12,
        color: "black",
        hint: "Provide name",
      },
    },
    {
      type: "date",
      page,
      x: 250,
      y,
      w: 112,
      h: 24,
      signer: role,
      role,
      options: {
        required: true,
        name: `date_${index + 1}`,
        format: "mm-dd-yyyy",
        fontsize: 12,
        color: "black",
        signing_date: true,
        hint: "Provide date",
      },
    },
  ];
}

function toSelfHostedWidget(widget: JsonRecord): JsonRecord {
  const type = getString(widget.type) ?? "text input";
  const options = record(widget.options);
  const required =
    typeof options.required === "boolean" ? options.required : true;
  const selfHostedOptions: JsonRecord = {
    status: required ? "required" : "optional",
    name: getString(options.name) ?? `${type}_${crypto.randomUUID()}`,
    response: "",
    hint: getString(options.hint) ?? "",
  };

  const fontSize = options.fontsize ?? options.fontSize;
  if (typeof fontSize === "number") selfHostedOptions.fontSize = fontSize;
  const color = getString(options.color) ?? getString(options.fontColor);
  if (color) selfHostedOptions.fontColor = color;
  const format = getString(options.format);
  if (format && type !== "date") selfHostedOptions.validation = { format };

  return {
    key: selfHostedOptions.name,
    xPosition: widget.x,
    yPosition: widget.y,
    Width: widget.w,
    Height: widget.h,
    type,
    ...(type === "signature" ? { signatureType: "" } : {}),
    options: selfHostedOptions,
  };
}

function buildSelfHostedPlaceholder(
  recipient: SigningRecipientInput,
  index: number,
  pageCount: number | null,
): JsonRecord | null {
  if (recipient.role === "CC" || recipient.role === "VIEWER") return null;
  const widgets = buildSignerWidgets(index, pageCount);
  const grouped = new Map<number, JsonRecord[]>();
  for (const widget of widgets) {
    const page = Number(widget.page) || Math.max(1, pageCount ?? 1);
    grouped.set(page, [
      ...(grouped.get(page) ?? []),
      toSelfHostedWidget(widget),
    ]);
  }
  return {
    signerObjId: "",
    signerPtr: {},
    Id: `mike-signer-${index + 1}`,
    blockColor: ["#93a3db", "#e6c3db", "#c0e3bc", "#bce3db"][index % 4],
    Role: signerRoleName(index),
    email: recipient.email,
    placeHolder: Array.from(grouped.entries()).map(([pageNumber, pos]) => ({
      pageNumber,
      pos,
    })),
  };
}

function encodeSigningToken(providerRequestId: string, email: string): string {
  return Buffer.from(`${providerRequestId}/${email}`, "utf8").toString(
    "base64",
  );
}

function selfHostedSigningUrl(
  providerRequestId: string,
  email: string,
): string {
  return `${openSignPublicUrl()}/login/${encodeURIComponent(
    encodeSigningToken(providerRequestId, email),
  )}`;
}

function isSelfHostedEmailEnabled(): boolean {
  const value = process.env.OPENSIGN_SELFHOST_SEND_EMAIL?.trim().toLowerCase();
  if (!value) return true;
  return ["1", "true", "yes", "on"].includes(value);
}

function isSelfHostedEmailRequired(): boolean {
  return envTruthy("OPENSIGN_SELFHOST_REQUIRE_EMAIL");
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const expires = new Date(iso).valueOf();
  if (!Number.isFinite(expires)) return null;
  const days = Math.ceil((expires - Date.now()) / (24 * 60 * 60 * 1000));
  return Number.isFinite(days) && days > 0 ? days : null;
}

function pickDocumentId(value: unknown): string | null {
  const root = unwrap(value);
  return (
    getIdentifier(root.objectId) ??
    getIdentifier(root.id) ??
    getIdentifier(root._id) ??
    getIdentifier(root.document_id) ??
    getIdentifier(root.documentId) ??
    getIdentifier(root.DocumentId)
  );
}

function extractRecipients(value: unknown): JsonRecord[] {
  const root = unwrap(value);
  for (const key of [
    "signers",
    "Signers",
    "recipients",
    "Recipients",
    "signing_links",
    "signingLinks",
  ]) {
    const arr = arrayFrom(root[key]);
    if (arr.length > 0) return arr;
  }
  return [];
}

function extractSigningLinks(value: unknown): JsonRecord[] {
  const root = unwrap(value);
  for (const key of ["signing_links", "signingLinks", "signers", "Signers"]) {
    const arr = arrayFrom(root[key]);
    if (arr.length > 0) return arr;
  }
  if (Array.isArray(value)) return arrayFrom(value);
  return [];
}

function mapRecipients(
  fallback: SigningCreateInput["recipients"],
  response: unknown,
  links?: unknown,
): ProviderRecipientResult[] {
  const providerRecipients = extractRecipients(response);
  const linkRows = extractSigningLinks(links);

  return fallback.map((recipient, index) => {
    const role = signerRoleName(index);
    const providerRecipient =
      providerRecipients.find(
        (row) =>
          getString(row.email)?.toLowerCase() ===
            recipient.email.toLowerCase() ||
          getString(row.Email)?.toLowerCase() ===
            recipient.email.toLowerCase() ||
          getString(row.role) === role ||
          getString(row.Role) === role,
      ) ?? providerRecipients[index];
    const linkRow =
      linkRows.find(
        (row) =>
          getString(row.email)?.toLowerCase() ===
            recipient.email.toLowerCase() ||
          getString(row.Email)?.toLowerCase() ===
            recipient.email.toLowerCase() ||
          getString(row.role) === role ||
          getString(row.Role) === role,
      ) ?? linkRows[index];

    return {
      providerRecipientId:
        getIdentifier(providerRecipient?.objectId) ??
        getIdentifier(providerRecipient?.id) ??
        getIdentifier(linkRow?.objectId) ??
        getIdentifier(linkRow?.id),
      email:
        getString(providerRecipient?.email) ??
        getString(providerRecipient?.Email) ??
        recipient.email,
      name:
        getString(providerRecipient?.name) ??
        getString(providerRecipient?.Name) ??
        recipient.name,
      role: recipient.role,
      signingOrder: recipient.signingOrder,
      status: normalizeRecipientStatus(providerRecipient ?? linkRow ?? {}),
      signedAt:
        getString(providerRecipient?.signedAt) ??
        getString(providerRecipient?.SignedAt),
      openedAt:
        getString(providerRecipient?.openedAt) ??
        getString(providerRecipient?.OpenedAt),
      signingUrl:
        getString(linkRow?.signurl) ??
        getString(linkRow?.signUrl) ??
        getString(linkRow?.signing_url) ??
        getString(linkRow?.signingUrl) ??
        getString(linkRow?.url),
    };
  });
}

function pickSignedPdfUrl(value: unknown): string | null {
  const root = unwrap(value);
  return (
    getString(root.SignedUrl) ??
    getString(root.signedUrl) ??
    getString(root.signed_url) ??
    getString(root.completed_pdf_url) ??
    getString(root.download_url) ??
    getString(root.DownloadUrl)
  );
}

function toLocalOpenSignFileUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  let publicUrl: URL | null = null;
  try {
    publicUrl = new URL(openSignPublicUrl());
  } catch {
    publicUrl = null;
  }

  let localBase: URL;
  try {
    localBase = new URL(parseBase());
  } catch {
    return url;
  }

  if (publicUrl && parsed.origin === publicUrl.origin) {
    if (
      parsed.pathname.startsWith("/api/") ||
      parsed.pathname.startsWith("/app/")
    ) {
      return `${localBase.origin}${parsed.pathname}${parsed.search}`;
    }
    if (parsed.pathname.startsWith("/files/")) {
      return `${localBase.href.replace(/\/+$/, "")}${parsed.pathname}${parsed.search}`;
    }
  }

  return url;
}

async function getSelfHostedSignedFileUrl(
  providerRequestId: string,
  sourceUrl: string,
): Promise<string> {
  const response = record(
    await requestParseFunction("getsignedurl", {
      docId: providerRequestId,
      url: sourceUrl,
    }),
  );
  return getString(response.result) ?? sourceUrl;
}

async function sendSelfHostedSigningEmail(input: {
  providerRequestId: string;
  recipient: SigningRecipientInput;
  signingUrl: string;
  subject: string;
  message: string | null | undefined;
  extUserId: string | null;
}): Promise<JsonRecord> {
  const htmlMessage = input.message?.trim()
    ? `<p>${escapeHtml(input.message.trim())}</p>`
    : "";
  return unwrap(
    await requestParseFunction("sendmailv3", {
      from: "AutoYou",
      replyto: PUBLIC_REPLY_TO,
      recipient: input.recipient.email,
      subject: input.subject,
      text: `${input.subject}\n\nReview and sign: ${input.signingUrl}`,
      html: `${htmlMessage}<p><a href="${input.signingUrl}">Review and sign the document</a></p>`,
      extUserId: input.extUserId ?? "",
      docId: input.providerRequestId,
    }),
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function getSelfHostedExtUser(
  session: ParseSession,
): Promise<JsonRecord> {
  const where = encodeURIComponent(
    JSON.stringify({
      UserId: {
        __type: "Pointer",
        className: "_User",
        objectId: session.userId,
      },
    }),
  );
  const response = record(
    await requestParseJson(`/classes/contracts_Users?where=${where}&limit=1`, {
      headers: parseHeaders({ "X-Parse-Master-Key": parseMasterKey() }),
    }),
  );
  const row = arrayFrom(response.results)[0];
  if (!row)
    throw new Error("OpenSign self-hosted admin user profile not found");
  return row;
}

async function uploadSelfHostedPdf(
  session: ParseSession,
  input: SigningCreateInput,
): Promise<JsonRecord> {
  const filename = `${Date.now()}-${safeFilename(input.filename)}`;
  return record(
    await requestParseJson(`/files/${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: parseHeaders({
        "X-Parse-Session-Token": session.sessionToken,
        "Content-Type": "application/pdf",
      }),
      body: Buffer.from(input.pdfBytes) as BodyInit,
    }),
  );
}

function selfHostedStatus(
  document: JsonRecord,
): ReturnType<typeof normalizeSigningStatus> {
  if (document.IsDeclined) return "declined";
  if (document.IsCompleted) return "completed";
  return normalizeSigningStatus(
    document.DocumentStatus ?? document.status ?? "sent",
  );
}

async function createSelfHostedSignatureRequest(
  input: SigningCreateInput,
): Promise<ProviderCreateResult> {
  const session = await parseLogin();
  const [extUser, file] = await Promise.all([
    getSelfHostedExtUser(session),
    uploadSelfHostedPdf(session, input),
  ]);
  const fileUrl = getString(file.url);
  if (!fileUrl) throw new Error("OpenSign self-hosted file upload failed");
  const placeholders = input.recipients
    .map((recipient, index) =>
      buildSelfHostedPlaceholder(recipient, index, input.pageCount),
    )
    .filter((placeholder): placeholder is JsonRecord => Boolean(placeholder));
  const acl: JsonRecord = {
    [session.userId]: { read: true, write: true },
  };
  const completionDays = daysUntil(input.expiresAt);
  const bccRecipients = input.recipients
    .filter(
      (recipient) =>
        recipient.role === "CC" && recipient.email === PUBLIC_REPLY_TO,
    )
    .map((recipient) => ({ Email: recipient.email, Name: recipient.name }));
  const ccRecipients = input.recipients
    .filter(
      (recipient) =>
        recipient.role === "CC" && recipient.email !== PUBLIC_REPLY_TO,
    )
    .map((recipient) => ({ Email: recipient.email, Name: recipient.name }));
  const documentBody: JsonRecord = {
    Name: pdfFilename(input.title || input.filename),
    URL: fileUrl,
    SignedUrl: fileUrl,
    Note: input.message ?? "",
    Description: input.subject ?? "",
    CreatedBy: {
      __type: "Pointer",
      className: "_User",
      objectId: session.userId,
    },
    ExtUserPtr: {
      __type: "Pointer",
      className: "contracts_Users",
      objectId: getIdentifier(extUser.objectId),
    },
    SentToOthers: true,
    SendinOrder: input.recipients.some(
      (recipient, index) => recipient.signingOrder !== index + 1,
    ),
    SendInOrderStrict: input.recipients.some(
      (recipient, index) => recipient.signingOrder !== index + 1,
    ),
    TimeToCompleteDays: completionDays ?? 15,
    AutomaticReminders: false,
    NotifyOnSignatures: true,
    Placeholders: placeholders,
    Signers: [],
    ACL: acl,
    OriginIp: "127.0.0.1",
    DocSentAt: { __type: "Date", iso: new Date().toISOString() },
    ...(bccRecipients.length > 0 ? { Bcc: bccRecipients } : {}),
    ...(ccRecipients.length > 0 ? { Cc: ccRecipients } : {}),
  };
  const createResponse = record(
    await requestParseJson("/classes/contracts_Document", {
      method: "POST",
      headers: parseHeaders({
        "X-Parse-Session-Token": session.sessionToken,
        "X-Parse-Master-Key": parseMasterKey(),
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(documentBody),
    }),
  );
  const providerRequestId = getIdentifier(createResponse.objectId);
  if (!providerRequestId) {
    throw new Error(
      "OpenSign self-hosted document creation did not return an id",
    );
  }
  const recipients: ProviderRecipientResult[] = input.recipients.map(
    (recipient) => ({
      providerRecipientId: null,
      email: recipient.email,
      name: recipient.name,
      role: recipient.role,
      signingOrder: recipient.signingOrder,
      status:
        recipient.role === "CC" || recipient.role === "VIEWER"
          ? "completed"
          : "sent",
      signingUrl:
        recipient.role === "CC" || recipient.role === "VIEWER"
          ? null
          : selfHostedSigningUrl(providerRequestId, recipient.email),
    }),
  );
  const emailResults = isSelfHostedEmailEnabled()
    ? await Promise.all(
        input.recipients
          .filter(
            (recipient) =>
              recipient.role !== "CC" && recipient.role !== "VIEWER",
          )
          .map(async (recipient) => {
            const signingUrl = selfHostedSigningUrl(
              providerRequestId,
              recipient.email,
            );
            try {
              const response = await sendSelfHostedSigningEmail({
                providerRequestId,
                recipient,
                signingUrl,
                subject: input.subject || `Signature request: ${input.title}`,
                message: input.message,
                extUserId: getIdentifier(extUser.objectId),
              });
              const status = getString(response.status) ?? "unknown";
              if (isSelfHostedEmailRequired() && status !== "success") {
                throw new Error(
                  `OpenSign self-hosted email failed with status ${status}`,
                );
              }
              return { email: recipient.email, status };
            } catch (error) {
              if (isSelfHostedEmailRequired()) throw error;
              return {
                email: recipient.email,
                status: "error",
                detail: error instanceof Error ? error.message : String(error),
              };
            }
          }),
      )
    : [];

  return {
    providerRequestId,
    providerPayload: {
      mode: "selfhost",
      file,
      document: createResponse,
      emailResults,
    },
    status: "sent",
    recipients,
    sentAt: new Date().toISOString(),
  };
}

async function getSelfHostedDocument(
  providerRequestId: string,
): Promise<JsonRecord> {
  return record(
    await requestParseJson(
      `/classes/contracts_Document/${encodeURIComponent(providerRequestId)}`,
      {
        headers: parseHeaders({ "X-Parse-Master-Key": parseMasterKey() }),
      },
    ),
  );
}

async function getSelfHostedStatus(
  providerRequestId: string,
  recipients: SigningRecipientInput[],
): Promise<ProviderStatusResult> {
  const document = await getSelfHostedDocument(providerRequestId);
  return {
    providerRequestId,
    providerPayload: { mode: "selfhost", document },
    status: selfHostedStatus(document),
    recipients: recipients.map((recipient) => ({
      providerRecipientId: null,
      email: recipient.email,
      name: recipient.name,
      role: recipient.role,
      signingOrder: recipient.signingOrder,
      status:
        selfHostedStatus(document) === "completed"
          ? "signed"
          : recipient.role === "CC" || recipient.role === "VIEWER"
            ? "completed"
            : "sent",
      signingUrl:
        recipient.role === "CC" || recipient.role === "VIEWER"
          ? null
          : selfHostedSigningUrl(providerRequestId, recipient.email),
    })),
    sentAt: pickTimestamp(document, ["DocSentAt", "createdAt"]),
    completedAt: document.IsCompleted
      ? pickTimestamp(document, ["updatedAt", "CompletedDate"])
      : null,
  };
}

async function downloadSelfHostedSignedPdf(
  providerRequestId: string,
): Promise<SignedPdfResult> {
  const document = await getSelfHostedDocument(providerRequestId);
  const url = pickSignedPdfUrl(document);
  if (!url) {
    throw new Error(
      "OpenSign self-hosted document does not have a signed PDF URL",
    );
  }
  const signedUrl = await getSelfHostedSignedFileUrl(providerRequestId, url);
  const response = await fetch(toLocalOpenSignFileUrl(signedUrl));
  if (!response.ok) {
    throw new Error(
      `OpenSign self-hosted signed PDF download failed: ${await readError(response)}`,
    );
  }
  const title =
    getString(document.Name) ?? getString(document.title) ?? providerRequestId;
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    filename: pdfFilename(
      `${title.replace(/[^a-z0-9._ -]/gi, "_")}_signed.pdf`,
    ),
  };
}

function pickTimestamp(value: unknown, keys: string[]): string | null {
  const root = unwrap(value);
  for (const key of keys) {
    const raw = getString(root[key]);
    if (!raw) continue;
    const date = new Date(raw);
    return Number.isNaN(date.valueOf()) ? raw : date.toISOString();
  }
  return null;
}

function verifyHmac(
  receivedSignature: unknown,
  rawBody: Buffer | undefined,
  fallbackBody: unknown,
  secret: string | undefined,
): boolean {
  if (!secret) return !isOpenSignWebhookSecretRequired();
  const received = Array.isArray(receivedSignature)
    ? receivedSignature[0]
    : receivedSignature;
  if (typeof received !== "string" || !received.trim()) return false;

  const body =
    rawBody ??
    Buffer.from(
      typeof fallbackBody === "string"
        ? fallbackBody
        : JSON.stringify(fallbackBody ?? {}),
    );
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  const candidates = [
    received.trim(),
    received.trim().replace(/^sha256=/i, ""),
  ];

  return candidates.some((candidate) => {
    const expectedBuffer = Buffer.from(expected);
    const candidateBuffer = Buffer.from(candidate);
    return (
      expectedBuffer.length === candidateBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, candidateBuffer)
    );
  });
}

function envTruthy(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(
    process.env[name]?.trim().toLowerCase() ?? "",
  );
}

export function isOpenSignWebhookSecretRequired(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    envTruthy("PUBLIC_WEBHOOK_REQUIRED") ||
    envTruthy("OPENSIGN_WEBHOOK_REQUIRED") ||
    envTruthy("OPEN_SIGN_WEBHOOK_REQUIRED")
  );
}

export const opensignProvider: SigningProvider = {
  name: "opensign",

  async createSignatureRequest(
    input: SigningCreateInput,
  ): Promise<ProviderCreateResult> {
    if (openSignApiMode() === "selfhost") {
      return createSelfHostedSignatureRequest(input);
    }

    const signers = input.recipients.map((recipient, index) => ({
      name: recipient.name,
      email: recipient.email,
      role: signerRoleName(index),
      signer_role: toOpenSignSignerRole(recipient.role),
      signing_order: recipient.signingOrder,
      widgets:
        recipient.role === "SIGNER"
          ? buildSignerWidgets(index, input.pageCount)
          : [],
    }));
    const widgets = signers.flatMap((signer) => signer.widgets);
    const hasSequentialOrder = input.recipients.some(
      (recipient, index) => recipient.signingOrder !== index + 1,
    );
    const completionDays = daysUntil(input.expiresAt);
    const payload: JsonRecord = {
      title: pdfFilename(input.title || input.filename),
      file_name: pdfFilename(input.filename),
      file: Buffer.from(input.pdfBytes).toString("base64"),
      external_id: `mike-signature-request:${input.requestId}`,
      signers,
      widgets,
      send_email: true,
      email_subject:
        input.subject ??
        "{{sender_name}} has requested you to sign {{document_title}}",
      email_body: input.message ?? undefined,
      description: input.subject ?? undefined,
      note: input.message ?? undefined,
      send_in_order: hasSequentialOrder,
      send_in_order_strict: hasSequentialOrder,
      allow_offline_sign: false,
      notify_on_signatures: true,
      auto_reminder: false,
    };
    if (completionDays) {
      payload.time_to_complete_days = completionDays;
      payload.timetocompletedays = completionDays;
    }

    const createResponse = await requestJson("/createdocument", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const providerRequestId = pickDocumentId(createResponse);
    if (!providerRequestId) {
      throw new Error("OpenSign did not return a document id");
    }

    let linksResponse: unknown = null;
    try {
      linksResponse = await requestJson(
        `/signinglinks/${encodeURIComponent(providerRequestId)}`,
        { method: "GET" },
      );
    } catch {
      linksResponse = null;
    }

    return {
      providerRequestId,
      providerPayload: {
        create: createResponse,
        signingLinks: linksResponse,
      },
      status: normalizeSigningStatus(
        unwrap(createResponse).status ??
          unwrap(createResponse).Status ??
          unwrap(createResponse).DocumentStatus,
      ),
      recipients: mapRecipients(
        input.recipients,
        createResponse,
        linksResponse,
      ),
      sentAt: new Date().toISOString(),
    };
  },

  async getSignatureRequestStatus(
    providerRequestId: string,
    recipients: SigningRecipientInput[],
  ): Promise<ProviderStatusResult> {
    if (openSignApiMode() === "selfhost") {
      return getSelfHostedStatus(providerRequestId, recipients);
    }

    const documentResponse = await requestJson(
      `/document/${encodeURIComponent(providerRequestId)}`,
      { method: "GET" },
    );
    let linksResponse: unknown = null;
    try {
      linksResponse = await requestJson(
        `/signinglinks/${encodeURIComponent(providerRequestId)}`,
        { method: "GET" },
      );
    } catch {
      linksResponse = null;
    }

    const root = unwrap(documentResponse);
    return {
      providerRequestId: pickDocumentId(documentResponse) ?? providerRequestId,
      providerPayload: {
        document: documentResponse,
        signingLinks: linksResponse,
      },
      status: normalizeSigningStatus(
        root.status ??
          root.Status ??
          root.document_status ??
          root.documentStatus ??
          root.DocumentStatus,
      ),
      recipients: mapRecipients(recipients, documentResponse, linksResponse),
      sentAt: pickTimestamp(documentResponse, [
        "sentAt",
        "SentAt",
        "createdAt",
        "CreatedAt",
      ]),
      completedAt: pickTimestamp(documentResponse, [
        "completedAt",
        "CompletedAt",
        "completed_at",
        "CompletedDate",
      ]),
    };
  },

  async downloadSignedPdf(providerRequestId: string): Promise<SignedPdfResult> {
    if (openSignApiMode() === "selfhost") {
      return downloadSelfHostedSignedPdf(providerRequestId);
    }

    const documentResponse = await requestJson(
      `/document/${encodeURIComponent(providerRequestId)}`,
      { method: "GET" },
    );
    const downloadUrl = pickSignedPdfUrl(documentResponse);
    if (!downloadUrl)
      throw new Error("OpenSign did not return a signed PDF URL");

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(
        `OpenSign signed PDF download failed: ${await readError(response)}`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const title =
      getString(unwrap(documentResponse).Name) ??
      getString(unwrap(documentResponse).title) ??
      providerRequestId;
    return {
      bytes,
      filename: pdfFilename(
        `${title.replace(/[^a-z0-9._ -]/gi, "_")}_signed.pdf`,
      ),
    };
  },

  verifyWebhook(req): boolean {
    return verifyHmac(
      req.headers["x-webhook-signature"],
      req.rawBody,
      req.body,
      process.env.OPENSIGN_WEBHOOK_SECRET,
    );
  },
};

export const opensignTestExports = {
  buildSignerWidgets,
  isOpenSignWebhookSecretRequired,
  mapRecipients,
  pickDocumentId,
  pickSignedPdfUrl,
  verifyHmac,
};
