import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { loadCandidateFor, requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { audit } from "@/lib/audit";
import { connectDb } from "@/lib/db/connect";
import { Employer } from "@/lib/db/models/employer";
import { userNameMap } from "@/lib/users/directory";
import { formatDate, todayIn } from "@/lib/compliance/dates";
import { DOCUMENT_TYPE_MAP, REQUIRED_DOCS } from "@/lib/documents/types";
import { SELF_REVIEW_ROLES, computeMissing, displayStatus, daysUntilExpiry, isRestrictedType, MISSING_REASON_LABELS } from "@/lib/documents/rules";
import { listCandidateDocuments, type DocumentView } from "@/lib/documents/service";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { CandidateTabProps } from "../tab-types";
import { DocStatusBadge } from "./status-badge";
import { DownloadButton } from "./download-button";
import { ReviewControls } from "./review-controls";
import { UploadForm } from "./upload-form";

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const day = (iso: string) => formatDate(iso.slice(0, 10));

export async function CandidateDocumentsTab({ candidateId }: CandidateTabProps) {
  const user = await requirePage("documents.view");
  const candidate = await loadCandidateFor(user, candidateId);
  if (!candidate) notFound();

  const groups = await listCandidateDocuments(user, candidateId);
  await connectDb();
  const employerRows = can(user, "documents.upload")
    ? await Employer.find().select("legalName").sort({ legalName: 1 }).limit(500).lean<{ _id: string; legalName: string }[]>()
    : [];
  const employerNames = new Map(employerRows.map((e) => [e._id, e.legalName]));
  const names = await userNameMap(groups.flatMap((g) => [g.latest, ...g.history]).flatMap((d) => [d.uploadedBy, d.reviewerId]));

  await audit({ actor: user, action: "read", entityType: "document", candidateId, summary: "Viewed candidate documents" });

  const today = todayIn(user.timezone);
  const canDownload = can(user, "documents.download");
  const canVerify = can(user, "documents.verify");
  const canUpload = can(user, "documents.upload");
  const canTax = can(user, "sensitive.tax.view");

  const latest = groups.map((g) => g.latest);
  const required = REQUIRED_DOCS[candidate.authType] ?? REQUIRED_DOCS.none;
  const gaps = new Map(computeMissing(candidate.authType, latest, today, required).map((g) => [g.type, g]));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Required documents"
          description={`Checklist for ${candidate.authType === "none" ? "a candidate with no authorization type set" : candidate.authType.replace("_", " ")}. A type is complete only with a verified, unexpired latest version.`}
        />
        <CardBody>
          <ul className="grid gap-2 sm:grid-cols-2">
            {required.map((type) => {
              const gap = gaps.get(type);
              return (
                <li key={type} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                  <span>{DOCUMENT_TYPE_MAP[type]?.label ?? type}</span>
                  {gap ? <DocStatusBadge status={gap.reason} /> : <DocStatusBadge status="verified" />}
                </li>
              );
            })}
          </ul>
          {gaps.size > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {[...gaps.values()].map((g) => `${g.label}: ${MISSING_REASON_LABELS[g.reason]}`).join(" · ")}
            </p>
          )}
        </CardBody>
      </Card>

      {canUpload && (
        <Card>
          <CardHeader title="Upload a document" description="New uploads start as awaiting review. Re-uploading to an existing document creates a new version." />
          <CardBody>
            <UploadForm
              candidateId={candidateId}
              employers={employerRows.map((e) => ({ id: e._id, name: e.legalName }))}
              canUploadRestricted={canTax}
              replaceable={groups.map((g) => ({
                groupId: g.groupId,
                label: `${g.typeLabel}${g.latest.title ? ` — ${g.latest.title}` : ""} (v${g.latest.version})`,
              }))}
            />
          </CardBody>
        </Card>
      )}

      {!canDownload && (
        <p className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" /> Your role can see document details but cannot download or preview files.
        </p>
      )}

      {groups.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-muted-foreground">No documents have been uploaded for this candidate yet.</CardBody>
        </Card>
      ) : (
        groups.map((g) => {
          const d = g.latest;
          const status = displayStatus(d, today);
          const left = daysUntilExpiry(d.expiryDate, today);
          const selfBlocked = d.uploadedBy === user.id && !SELF_REVIEW_ROLES.includes(user.role);
          return (
            <Card key={g.groupId}>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {g.typeLabel}
                    {d.title && <span className="font-normal text-muted-foreground">— {d.title}</span>}
                    <Badge tone="neutral">v{d.version}</Badge>
                    {(d.restricted || isRestrictedType(d.type)) && (
                      <Badge tone="info">
                        <Lock className="h-3 w-3" /> Restricted
                      </Badge>
                    )}
                  </span>
                }
                description={`${d.fileName} · ${fmtSize(d.sizeBytes)}`}
                action={<DocStatusBadge status={status} />}
              />
              <CardBody className="space-y-3 text-sm">
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
                  <Meta label="Uploaded">
                    {day(d.uploadedAt)} by {names[d.uploadedBy] ?? "—"}
                  </Meta>
                  <Meta label="Issued">{formatDate(d.issueDate)}</Meta>
                  <Meta label="Expires">
                    {d.expiryDate ? (
                      <>
                        {formatDate(d.expiryDate)}
                        {left !== null && (
                          <span className={left < 0 ? "text-danger" : left <= 30 ? "text-warning" : "text-muted-foreground"}>
                            {" "}
                            ({left < 0 ? `${-left}d ago` : `in ${left}d`})
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">Not recorded</span>
                    )}
                  </Meta>
                  <Meta label="Employer">{d.employerId ? (employerNames.get(d.employerId) ?? "—") : "—"}</Meta>
                  <Meta label="Reviewed">
                    {d.reviewedAt ? `${day(d.reviewedAt)} by ${d.reviewerId ? (names[d.reviewerId] ?? "—") : "—"}` : "Not yet reviewed"}
                  </Meta>
                  <Meta label="SHA-256">
                    <span className="font-mono text-xs text-muted-foreground">{d.sha256.slice(0, 16)}…</span>
                  </Meta>
                </dl>
                {d.reviewNote && (
                  <p className="rounded-md bg-muted/50 px-3 py-2 text-xs">
                    <span className="font-medium">Reviewer note:</span> {d.reviewNote}
                  </p>
                )}
                {canDownload && (
                  <div className="flex flex-wrap gap-2">
                    <DownloadButton documentId={d.id} />
                    {d.previewable && <DownloadButton documentId={d.id} inline />}
                  </div>
                )}
                {canVerify && d.verification === "pending_review" &&
                  (selfBlocked ? (
                    <p className="text-xs text-muted-foreground">You uploaded this version, so a different reviewer must verify or reject it.</p>
                  ) : (
                    <ReviewControls documentId={d.id} />
                  ))}
                {g.history.length > 0 && (
                  <details className="rounded-md border">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Version history ({g.history.length} earlier)</summary>
                    <ul className="divide-y">
                      {g.history.map((h) => (
                        <HistoryRow key={h.id} h={h} names={names} canDownload={canDownload} today={today} />
                      ))}
                    </ul>
                  </details>
                )}
              </CardBody>
            </Card>
          );
        })
      )}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function HistoryRow({ h, names, canDownload, today }: { h: DocumentView; names: Record<string, string>; canDownload: boolean; today: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-xs">
      <div className="space-y-0.5">
        <p>
          <span className="font-medium">v{h.version}</span> · {h.fileName} · {fmtSize(h.sizeBytes)}
        </p>
        <p className="text-muted-foreground">
          Uploaded {day(h.uploadedAt)} by {names[h.uploadedBy] ?? "—"}
          {h.reviewedAt && ` · reviewed ${day(h.reviewedAt)} by ${h.reviewerId ? (names[h.reviewerId] ?? "—") : "—"}`}
          {h.expiryDate && ` · expires ${formatDate(h.expiryDate)}`}
        </p>
        {h.reviewNote && <p className="text-muted-foreground">Note: {h.reviewNote}</p>}
      </div>
      <div className="flex items-center gap-2">
        {h.verification === "pending_review" ? <Badge tone="neutral">Superseded</Badge> : <DocStatusBadge status={displayStatus(h, today)} />}
        {canDownload && <DownloadButton documentId={h.id} />}
      </div>
    </li>
  );
}
