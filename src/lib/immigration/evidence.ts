import { connectDb } from "@/lib/db/connect";
import { DocumentModel, type IDocument } from "@/lib/db/models/document";
import type { Actor } from "@/lib/rbac/can";
import { can } from "@/lib/rbac/can";

/**
 * Read-only access to document metadata for evidence pickers and verification checks.
 * (The documents module owns uploads/verification; immigration only reads the verification STATE.)
 */
export interface EvidenceDocInfo {
  id: string;
  candidateId: string;
  type: string;
  title?: string;
  fileName: string;
  version: number;
  verification: IDocument["verification"];
  issueDate?: string;
  expiryDate?: string;
  restricted: boolean;
}

const PROJECTION = "candidateId type title fileName version verification issueDate expiryDate restricted";

function toInfo(d: IDocument): EvidenceDocInfo {
  return {
    id: d._id,
    candidateId: d.candidateId,
    type: d.type,
    title: d.title,
    fileName: d.fileName,
    version: d.version,
    verification: d.verification,
    issueDate: d.issueDate,
    expiryDate: d.expiryDate,
    restricted: d.restricted,
  };
}

/** Fetch one document row, only if it belongs to the candidate. */
export async function getEvidenceDoc(candidateId: string, documentId: string | null | undefined): Promise<EvidenceDocInfo | null> {
  if (!documentId) return null;
  await connectDb();
  const d = await DocumentModel.findOne({ _id: documentId, candidateId }).select(PROJECTION).lean<IDocument>();
  return d ? toInfo(d) : null;
}

export async function getEvidenceDocs(candidateId: string, ids: (string | null | undefined)[]): Promise<Map<string, EvidenceDocInfo>> {
  const uniq = [...new Set(ids.filter(Boolean) as string[])];
  if (!uniq.length) return new Map();
  await connectDb();
  const rows = await DocumentModel.find({ _id: { $in: uniq }, candidateId }).select(PROJECTION).lean<IDocument[]>();
  return new Map(rows.map((d) => [d._id, toInfo(d)]));
}

/** Latest-version immigration-category documents of a candidate, for the evidence picker. */
export async function listEvidenceCandidates(actor: Actor, candidateId: string): Promise<EvidenceDocInfo[]> {
  if (!can(actor, "documents.view")) return [];
  await connectDb();
  const filter: Record<string, unknown> = { candidateId, isLatest: true, category: "immigration" };
  if (!can(actor, "sensitive.tax.view")) filter.restricted = false;
  const rows = await DocumentModel.find(filter).select(PROJECTION).sort({ createdAt: -1 }).limit(100).lean<IDocument[]>();
  return rows.map(toInfo);
}

export const isDocVerified = (d: EvidenceDocInfo | null | undefined) => !!d && d.verification === "verified";
