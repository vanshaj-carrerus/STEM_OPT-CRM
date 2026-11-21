import { Badge, type Tone } from "@/components/ui/badge";
import type { DisplayStatus, MissingReason } from "@/lib/documents/rules";

const MAP: Record<DisplayStatus | MissingReason, { label: string; tone: Tone }> = {
  verified: { label: "Verified", tone: "success" },
  pending_review: { label: "Awaiting review", tone: "warning" },
  rejected: { label: "Rejected", tone: "danger" },
  expired: { label: "Expired", tone: "danger" },
  not_uploaded: { label: "Not uploaded", tone: "neutral" },
};

export function DocStatusBadge({ status }: { status: DisplayStatus | MissingReason }) {
  const s = MAP[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
