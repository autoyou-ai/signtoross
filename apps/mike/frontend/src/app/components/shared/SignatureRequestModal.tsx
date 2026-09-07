"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
    Download,
    ExternalLink,
    Loader2,
    Plus,
    Send,
    Trash2,
    X,
} from "lucide-react";
import {
    getSignatureRequestSignedUrl,
    listSignatureRequests,
    syncSignatureRequest,
    type CreateSignatureRecipient,
} from "@/app/lib/mikeApi";
import type { MikeDocument, MikeSignatureRequest } from "./types";
import { SignatureStatusChip } from "./SignatureStatusChip";

interface Props {
    open: boolean;
    doc: MikeDocument | null;
    onClose: () => void;
    onSubmit: (payload: {
        subject: string | null;
        message: string | null;
        expires_at: string | null;
        recipients: CreateSignatureRecipient[];
    }) => Promise<void>;
}

type DraftRecipient = CreateSignatureRecipient;
type HistoryLoadOptions = {
    showSpinner?: boolean;
    clearOnError?: boolean;
    syncProvider?: boolean;
};

const TERMINAL_REQUEST_STATUSES = new Set([
    "completed",
    "declined",
    "expired",
    "cancelled",
    "failed",
]);

const EMPTY_RECIPIENT: DraftRecipient = {
    name: "",
    email: "",
    role: "SIGNER",
    signing_order: 1,
};

function defaultSubject(doc: MikeDocument | null) {
    return doc ? `Please sign ${doc.filename}` : "Please sign this document";
}

function canSyncProviderStatus(request: MikeSignatureRequest) {
    return (
        !!request.provider_request_id &&
        !TERMINAL_REQUEST_STATUSES.has(request.status)
    );
}

export function SignatureRequestModal({
    open,
    doc,
    onClose,
    onSubmit,
}: Props) {
    const [mounted, setMounted] = useState(false);
    const [subject, setSubject] = useState("");
    const [message, setMessage] = useState("");
    const [expiresAt, setExpiresAt] = useState("");
    const [recipients, setRecipients] = useState<DraftRecipient[]>([
        EMPTY_RECIPIENT,
    ]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [history, setHistory] = useState<MikeSignatureRequest[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyRefreshing, setHistoryRefreshing] = useState(false);
    const [downloadingRequestId, setDownloadingRequestId] = useState<
        string | null
    >(null);
    const documentId = doc?.id ?? null;

    useEffect(() => setMounted(true), []);

    const loadHistory = useCallback(
        async (options: HistoryLoadOptions = {}) => {
            if (!documentId) return;
            if (options.showSpinner) setHistoryLoading(true);
            else setHistoryRefreshing(true);
            try {
                let requests = await listSignatureRequests(documentId);
                if (options.syncProvider) {
                    const syncResults = await Promise.allSettled(
                        requests
                            .filter(canSyncProviderStatus)
                            .map((request) => syncSignatureRequest(request.id)),
                    );
                    const syncedById = new Map(
                        syncResults
                            .filter(
                                (
                                    result,
                                ): result is PromiseFulfilledResult<MikeSignatureRequest> =>
                                    result.status === "fulfilled",
                            )
                            .map((result) => [result.value.id, result.value]),
                    );
                    requests = requests.map(
                        (request) => syncedById.get(request.id) ?? request,
                    );
                }
                setHistory(requests);
            } catch {
                if (options.clearOnError) setHistory([]);
            } finally {
                if (options.showSpinner) setHistoryLoading(false);
                else setHistoryRefreshing(false);
            }
        },
        [documentId],
    );

    useEffect(() => {
        if (!open || !doc) return;
        setSubject(defaultSubject(doc));
        setMessage("");
        setExpiresAt("");
        setRecipients([{ ...EMPTY_RECIPIENT }]);
        setSubmitting(false);
        setError(null);
        setNotice(null);
        setHistory([]);
        void loadHistory({ showSpinner: true, clearOnError: true });
    }, [open, doc, loadHistory]);

    const hasActiveRequests = useMemo(
        () =>
            history.some(
                (request) => !TERMINAL_REQUEST_STATUSES.has(request.status),
            ),
        [history],
    );

    useEffect(() => {
        if (!open || !documentId || !hasActiveRequests) return;
        const intervalId = window.setInterval(() => {
            void loadHistory({ syncProvider: true });
        }, 15_000);
        return () => window.clearInterval(intervalId);
    }, [open, documentId, hasActiveRequests, loadHistory]);

    if (!open || !doc || !mounted) return null;

    const hasPdf = !!doc.pdf_storage_path;
    const canSubmit =
        hasPdf &&
        !submitting &&
        recipients.some((recipient) => recipient.role === "SIGNER") &&
        recipients.every(
            (recipient) =>
                recipient.name.trim() &&
                recipient.email.trim() &&
                recipient.email.includes("@"),
        );

    function updateRecipient(
        index: number,
        patch: Partial<DraftRecipient>,
    ) {
        setRecipients((prev) =>
            prev.map((recipient, i) =>
                i === index ? { ...recipient, ...patch } : recipient,
            ),
        );
    }

    function addRecipient() {
        setRecipients((prev) => [
            ...prev,
            {
                ...EMPTY_RECIPIENT,
                signing_order: prev.length + 1,
            },
        ]);
    }

    function removeRecipient(index: number) {
        setRecipients((prev) =>
            prev
                .filter((_, i) => i !== index)
                .map((recipient, i) => ({
                    ...recipient,
                    signing_order: i + 1,
                })),
        );
    }

    async function handleSubmit() {
        if (!canSubmit) return;
        setSubmitting(true);
        setError(null);
        setNotice(null);
        try {
            await onSubmit({
                subject: subject.trim() || null,
                message: message.trim() || null,
                expires_at: expiresAt ? `${expiresAt}T23:59:59.000Z` : null,
                recipients: recipients.map((recipient, index) => ({
                    name: recipient.name.trim(),
                    email: recipient.email.trim().toLowerCase(),
                    role: recipient.role,
                    signing_order: recipient.signing_order || index + 1,
                })),
            });
            setNotice("Signature request sent.");
            await loadHistory({ showSpinner: true, syncProvider: true });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSubmitting(false);
        }
    }

    async function downloadSignedPdf(request: MikeSignatureRequest) {
        if (request.status !== "completed") return;
        setDownloadingRequestId(request.id);
        try {
            const { url, filename } = await getSignatureRequestSignedUrl(
                request.id,
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.click();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setDownloadingRequestId(null);
        }
    }

    function recipientStatusLabel(status: string) {
        return status.replace(/_/g, " ");
    }

    function formatDate(iso: string | null) {
        if (!iso) return null;
        return new Date(iso).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
        });
    }

    return createPortal(
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/10 backdrop-blur-xs">
            <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
                <div className="flex items-start justify-between gap-4 px-5 py-4">
                    <div className="min-w-0">
                        <p className="text-xs text-gray-400">
                            Send for signature
                        </p>
                        <h2 className="truncate text-base font-medium text-gray-900">
                            {doc.filename}
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
                    {!hasPdf && (
                        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                            A PDF rendition is required before sending. Install
                            LibreOffice, then upload or regenerate this version.
                        </div>
                    )}

                    <div className="grid gap-4">
                        <div>
                            <label className="mb-1 block text-xs font-medium text-gray-500">
                                Email subject
                            </label>
                            <input
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
                            />
                        </div>

                        <div>
                            <label className="mb-1 block text-xs font-medium text-gray-500">
                                Message
                            </label>
                            <textarea
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                rows={3}
                                className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
                            />
                        </div>

                        <div className="w-full max-w-xs">
                            <label className="mb-1 block text-xs font-medium text-gray-500">
                                Expiry date
                            </label>
                            <input
                                type="date"
                                value={expiresAt}
                                onChange={(e) => setExpiresAt(e.target.value)}
                                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
                            />
                        </div>
                    </div>

                    <div className="mt-5">
                        <div className="mb-2 flex items-center justify-between">
                            <p className="text-xs font-medium text-gray-500">
                                Recipients
                            </p>
                            <button
                                type="button"
                                onClick={addRecipient}
                                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Add recipient
                            </button>
                        </div>

                        <div className="space-y-2">
                            {recipients.map((recipient, index) => (
                                <div
                                    key={index}
                                    className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_110px_56px_32px]"
                                >
                                    <input
                                        value={recipient.name}
                                        onChange={(e) =>
                                            updateRecipient(index, {
                                                name: e.target.value,
                                            })
                                        }
                                        placeholder="Signer name"
                                        className="min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
                                    />
                                    <input
                                        value={recipient.email}
                                        onChange={(e) =>
                                            updateRecipient(index, {
                                                email: e.target.value,
                                            })
                                        }
                                        placeholder="signer@example.com"
                                        className="min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
                                    />
                                    <select
                                        value={recipient.role}
                                        onChange={(e) =>
                                            updateRecipient(index, {
                                                role: e.target
                                                    .value as DraftRecipient["role"],
                                            })
                                        }
                                        className="rounded-lg border border-gray-200 px-2 py-2 text-sm outline-none focus:border-gray-400"
                                    >
                                        <option value="SIGNER">Signer</option>
                                        <option value="APPROVER">Approver</option>
                                        <option value="VIEWER">Viewer</option>
                                        <option value="CC">CC</option>
                                    </select>
                                    <input
                                        type="number"
                                        min={0}
                                        value={recipient.signing_order}
                                        onChange={(e) =>
                                            updateRecipient(index, {
                                                signing_order:
                                                    Number.parseInt(
                                                        e.target.value,
                                                        10,
                                                    ) || 0,
                                            })
                                        }
                                        aria-label="Signing order"
                                        className="rounded-lg border border-gray-200 px-2 py-2 text-sm outline-none focus:border-gray-400"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => removeRecipient(index)}
                                        disabled={recipients.length === 1}
                                        className="flex h-9 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                                        aria-label="Remove recipient"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="mt-5">
                        <p className="mb-2 text-xs font-medium text-gray-500">
                            Signing history
                            {historyRefreshing && (
                                <Loader2 className="ml-1 inline h-3 w-3 animate-spin align-[-2px] text-gray-300" />
                            )}
                        </p>
                        <div className="rounded-lg border border-gray-100">
                            {historyLoading ? (
                                <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Loading
                                </div>
                            ) : history.length === 0 ? (
                                <p className="px-3 py-2 text-xs text-gray-400">
                                    No signature requests yet.
                                </p>
                            ) : (
                                history.map((request) => (
                                    <div
                                        key={request.id}
                                        className="border-b border-gray-50 px-3 py-2 last:border-b-0"
                                    >
                                        <div className="flex items-center gap-2">
                                            <SignatureStatusChip
                                                request={request}
                                            />
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-xs text-gray-700">
                                                    {request.subject ||
                                                        defaultSubject(doc)}
                                                </p>
                                                <p className="text-[11px] text-gray-400">
                                                    {formatDate(
                                                        request.sent_at ??
                                                            request.created_at,
                                                    )}
                                                </p>
                                            </div>
                                            {request.status ===
                                                "completed" && (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        void downloadSignedPdf(
                                                            request,
                                                        )
                                                    }
                                                    disabled={
                                                        downloadingRequestId ===
                                                        request.id
                                                    }
                                                    className="inline-flex h-7 items-center gap-1 rounded-lg border border-gray-200 px-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                                                >
                                                    {downloadingRequestId ===
                                                    request.id ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : (
                                                        <Download className="h-3.5 w-3.5" />
                                                    )}
                                                    PDF
                                                </button>
                                            )}
                                        </div>
                                        {request.recipients.length > 0 && (
                                            <div className="mt-2 space-y-1 pl-1">
                                                {request.recipients.map(
                                                    (recipient) => (
                                                        <div
                                                            key={recipient.id}
                                                            className="flex items-center gap-2 text-[11px] text-gray-500"
                                                        >
                                                            <span className="min-w-0 flex-1 truncate">
                                                                {recipient.name}{" "}
                                                                <span className="text-gray-300">
                                                                    {
                                                                        recipient.email
                                                                    }
                                                                </span>
                                                            </span>
                                                            <span className="shrink-0 capitalize text-gray-400">
                                                                {recipientStatusLabel(
                                                                    recipient.status,
                                                                )}
                                                            </span>
                                                            {recipient.signing_url && (
                                                                <a
                                                                    href={
                                                                        recipient.signing_url
                                                                    }
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-50"
                                                                >
                                                                    <ExternalLink className="h-3 w-3" />
                                                                    Link
                                                                </a>
                                                            )}
                                                        </div>
                                                    ),
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    {error && (
                        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                            {error}
                        </div>
                    )}
                    {notice && !error && (
                        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                            {notice}
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
                    <button
                        onClick={onClose}
                        className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
                    >
                        {submitting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Send className="h-3.5 w-3.5" />
                        )}
                        Send
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
