export const SIGNING_PROVIDER = "opensign" as const;
export const SIGNING_PROVIDERS = ["opensign"] as const;
export type SigningProviderName = (typeof SIGNING_PROVIDERS)[number];

export const SIGNING_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "partially_signed",
  "completed",
  "declined",
  "expired",
  "cancelled",
  "failed",
] as const;

export type SigningStatus = (typeof SIGNING_STATUSES)[number];

export type SigningRecipientRole = "SIGNER" | "APPROVER" | "CC" | "VIEWER";

export type SigningRecipientStatus =
  | "pending"
  | "sent"
  | "viewed"
  | "signed"
  | "declined"
  | "completed";

export interface SigningRecipientInput {
  name: string;
  email: string;
  role: SigningRecipientRole;
  signingOrder: number;
}

export interface SigningCreateInput {
  requestId: string;
  documentId: string;
  title: string;
  filename: string;
  pdfBytes: ArrayBuffer;
  pageCount: number | null;
  subject: string | null;
  message: string | null;
  expiresAt: string | null;
  recipients: SigningRecipientInput[];
}

export interface ProviderRecipientResult {
  providerRecipientId: string | null;
  email: string;
  name: string;
  role: SigningRecipientRole;
  signingOrder: number | null;
  status: SigningRecipientStatus;
  signedAt?: string | null;
  openedAt?: string | null;
  signingUrl?: string | null;
}

export interface ProviderCreateResult {
  providerRequestId: string;
  providerPayload: unknown;
  status: SigningStatus;
  recipients: ProviderRecipientResult[];
  sentAt: string | null;
}

export interface ProviderStatusResult {
  providerRequestId: string;
  providerPayload: unknown;
  status: SigningStatus;
  recipients: ProviderRecipientResult[];
  sentAt?: string | null;
  completedAt?: string | null;
}

export interface SignedPdfResult {
  bytes: Buffer;
  filename: string;
}

export interface SigningProvider {
  name: SigningProviderName;
  createSignatureRequest(input: SigningCreateInput): Promise<ProviderCreateResult>;
  getSignatureRequestStatus?(
    providerRequestId: string,
    recipients: SigningRecipientInput[],
  ): Promise<ProviderStatusResult>;
  downloadSignedPdf(providerRequestId: string): Promise<SignedPdfResult>;
  verifyWebhook(req: {
    headers: Record<string, string | string[] | undefined>;
    rawBody?: Buffer;
    body?: unknown;
  }): boolean;
}

export function normalizeSigningStatus(
  providerStatus: unknown,
  eventType?: string | null,
): SigningStatus {
  const status = String(providerStatus ?? "").toUpperCase();
  if (["COMPLETED", "COMPLETE", "SIGNED", "DONE", "FINISHED"].includes(status)) {
    return "completed";
  }
  if (["REJECTED", "DECLINED"].includes(status)) return "declined";
  if (status === "CANCELLED") return "cancelled";
  if (status === "EXPIRED") return "expired";

  const event = String(eventType ?? "").toUpperCase();
  if (event.includes("OPENED") || event.includes("VIEWED")) return "viewed";
  if (event.includes("SIGNED") || event.includes("RECIPIENT_COMPLETED"))
    return "partially_signed";
  if (event.includes("COMPLETED") || event.includes("FINISHED")) return "completed";
  if (event.includes("REJECTED") || event.includes("DECLINED")) return "declined";
  if (event.includes("CANCELLED")) return "cancelled";
  if (event.includes("EXPIRED")) return "expired";

  switch (status) {
    case "DRAFT":
      return "draft";
    case "PENDING":
    case "IN PROGRESS":
    case "IN_PROGRESS":
    case "OUT FOR SIGNATURE":
    case "OUT_FOR_SIGNATURE":
      return "sent";
    default:
      return "sent";
  }
}

export function normalizeRecipientStatus(recipient: {
  status?: unknown;
  Status?: unknown;
  signerStatus?: unknown;
  signingStatus?: unknown;
  readStatus?: unknown;
  sendStatus?: unknown;
  role?: unknown;
}): SigningRecipientStatus {
  const signingStatus = String(
    recipient.signingStatus ??
      recipient.signerStatus ??
      recipient.status ??
      recipient.Status ??
      "",
  ).toUpperCase();
  if (["SIGNED", "COMPLETED", "COMPLETE", "DONE"].includes(signingStatus)) {
    return "signed";
  }
  if (["REJECTED", "DECLINED"].includes(signingStatus)) return "declined";
  if (["VIEWED", "OPENED"].includes(signingStatus)) return "viewed";
  if (["SENT", "PENDING", "IN PROGRESS", "IN_PROGRESS"].includes(signingStatus)) {
    return "sent";
  }

  const readStatus = String(recipient.readStatus ?? "").toUpperCase();
  if (readStatus === "OPENED") return "viewed";

  const sendStatus = String(recipient.sendStatus ?? "").toUpperCase();
  if (sendStatus === "SENT") return "sent";

  const role = String(recipient.role ?? "").toUpperCase();
  if (role === "CC" || role === "VIEWER") return "completed";

  return "pending";
}
