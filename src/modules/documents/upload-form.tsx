"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Field, FormAlert, Input, Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { CATEGORY_LABELS, DOCUMENT_TYPES } from "@/lib/documents/types";

export interface ReplaceOption {
  groupId: string;
  label: string;
}

const MAX_MB = 15;

/**
 * Posts to the multipart route handler (server actions have a small body limit). Choosing an existing document under
 * "Upload as" makes the file its next version (type is inherited and the new version restarts review).
 */
export function UploadForm({
  candidateId,
  employers,
  replaceable,
  canUploadRestricted,
}: {
  candidateId: string;
  employers: { id: string; name: string }[];
  replaceable: ReplaceOption[];
  canUploadRestricted: boolean;
}) {
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [replacing, setReplacing] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    setOk(undefined);
    const fd = new FormData(e.currentTarget);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return setError("Choose a file to upload.");
    if (file.size > MAX_MB * 1024 * 1024) return setError(`File exceeds the ${MAX_MB} MB limit.`);
    setBusy(true);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/documents`, { method: "POST", body: fd, credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; version?: number; details?: { message: string }[] };
      if (!res.ok) {
        setError(body.details?.[0]?.message ?? body.error ?? "Upload failed.");
        return;
      }
      setOk(`Uploaded as version ${body.version}. It is now awaiting review.`);
      ref.current?.reset();
      setReplacing(false);
      router.refresh();
    } catch {
      setError("Network error — the file was not uploaded.");
    } finally {
      setBusy(false);
    }
  }

  const types = DOCUMENT_TYPES.filter((t) => canUploadRestricted || !t.restricted);

  return (
    <form ref={ref} onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2 sm:col-span-2">
        <FormAlert error={error} message={ok} />
      </div>
      <Field label="Upload as" htmlFor="groupId" hint="Pick an existing document to add a new version; earlier versions are kept.">
        <Select id="groupId" name="groupId" defaultValue="" onChange={(e) => setReplacing(e.target.value !== "")}>
          <option value="">New document</option>
          {replaceable.map((r) => (
            <option key={r.groupId} value={r.groupId}>
              New version of: {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Document type" htmlFor="type" required={!replacing}>
        <Select id="type" name="type" defaultValue="" disabled={replacing} required={!replacing}>
          <option value="">Select type…</option>
          {Object.entries(CATEGORY_LABELS).map(([cat, label]) => {
            const opts = types.filter((t) => t.category === cat);
            return opts.length ? (
              <optgroup key={cat} label={label}>
                {opts.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </Select>
      </Field>
      <Field label="Issue date" htmlFor="issueDate">
        <Input id="issueDate" name="issueDate" type="date" />
      </Field>
      <Field label="Expiry date" htmlFor="expiryDate" hint="Drives expiring-document alerts.">
        <Input id="expiryDate" name="expiryDate" type="date" />
      </Field>
      <Field label="Employer (optional)" htmlFor="employerId">
        <Select id="employerId" name="employerId" defaultValue="">
          <option value="">—</option>
          {employers.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Title / note (optional)" htmlFor="title">
        <Input id="title" name="title" maxLength={120} placeholder="e.g. CPT I-20 — Acme Corp" />
      </Field>
      <Field
        label="File"
        htmlFor="file"
        required
        hint={`PDF, PNG, JPG, DOC, DOCX or XLSX up to ${MAX_MB} MB. Files are scanned and stored encrypted.`}
        className="sm:col-span-2"
      >
        <Input id="file" name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xlsx" className="h-auto py-1.5" />
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Uploading…" : "Upload document"}
        </Button>
      </div>
    </form>
  );
}
