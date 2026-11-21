import { z } from "zod";
import { isDateOnly } from "@/lib/compliance/dates";
import { DOCUMENT_TYPE_MAP } from "./types";

const blankToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optDate = z.preprocess(blankToUndef, z.string().trim().refine(isDateOnly, "Use a valid date (YYYY-MM-DD)").optional());
const optText = (max: number) => z.preprocess(blankToUndef, z.string().trim().max(max).optional());

/** Upload metadata. When `groupId` is given the upload is a NEW VERSION of that document and `type` is inherited. */
export const uploadMetaSchema = z
  .object({
    type: optText(40),
    groupId: optText(64),
    title: optText(120),
    employerId: optText(64),
    issueDate: optDate,
    expiryDate: optDate,
  })
  .superRefine((v, ctx) => {
    if (!v.groupId && !(v.type && DOCUMENT_TYPE_MAP[v.type])) {
      ctx.addIssue({ code: "custom", path: ["type"], message: "Choose a document type" });
    }
    if (v.issueDate && v.expiryDate && v.expiryDate < v.issueDate) {
      ctx.addIssue({ code: "custom", path: ["expiryDate"], message: "Expiry must be on/after the issue date" });
    }
  });
export type UploadMeta = z.infer<typeof uploadMetaSchema>;

export const reviewSchema = z.object({
  documentId: z.string().min(1).max(64),
  decision: z.enum(["verified", "rejected"]),
  note: optText(1000),
});
export type ReviewInput = z.infer<typeof reviewSchema>;

export const QUEUE_FILTERS = ["awaiting", "expiring", "expired", "rejected", "missing"] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];
