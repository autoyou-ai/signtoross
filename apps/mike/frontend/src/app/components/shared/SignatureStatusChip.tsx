import type {
    MikeSignatureRequestSummary,
    MikeSignatureStatus,
} from "./types";

const STATUS_LABELS: Record<MikeSignatureStatus, string> = {
    draft: "Draft",
    sent: "Sent",
    viewed: "Viewed",
    partially_signed: "Part signed",
    completed: "Signed",
    declined: "Declined",
    expired: "Expired",
    cancelled: "Cancelled",
    failed: "Failed",
};

const STATUS_CLASSES: Record<MikeSignatureStatus, string> = {
    draft: "border-gray-200 bg-gray-50 text-gray-600",
    sent: "border-blue-200 bg-blue-50 text-blue-700",
    viewed: "border-indigo-200 bg-indigo-50 text-indigo-700",
    partially_signed: "border-amber-200 bg-amber-50 text-amber-700",
    completed: "border-emerald-200 bg-emerald-50 text-emerald-700",
    declined: "border-red-200 bg-red-50 text-red-700",
    expired: "border-gray-200 bg-gray-50 text-gray-600",
    cancelled: "border-gray-200 bg-gray-50 text-gray-600",
    failed: "border-red-200 bg-red-50 text-red-700",
};

export function SignatureStatusChip({
    request,
}: {
    request?: MikeSignatureRequestSummary | null;
}) {
    if (!request) return null;
    return (
        <span
            className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASSES[request.status]}`}
            title={`Signature request: ${STATUS_LABELS[request.status]}`}
        >
            {STATUS_LABELS[request.status]}
        </span>
    );
}
