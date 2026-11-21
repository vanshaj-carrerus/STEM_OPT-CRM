"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormAlert, Input, Label, Select } from "@/components/ui/form";
import { RECEIPT_KINDS, RECEIPT_KIND_LABELS } from "@/lib/payments/evidence";
import { mintReceiptDownloadAction } from "@/app/(app)/payments/actions";

/** Asks the server for a 60-second signed link (permission-checked + audited), then follows it. */
export function ReceiptDownloadButton({ receiptId }: { receiptId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(undefined);
            const r = await mintReceiptDownloadAction(receiptId);
            if (r.error || !r.url) return setError(r.error ?? "Could not start the download.");
            window.location.assign(r.url);
          })
        }
      >
        <Download className="h-3.5 w-3.5" /> {pending ? "Preparing…" : "Download"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

/** Evidence upload → POST /api/payments/:id/receipts (multipart; encrypted + scanned on the server). */
export function ReceiptUploadForm({ paymentId, wire }: { paymentId: string; wire: boolean }) {
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    setOk(undefined);
    setBusy(true);
    try {
      const res = await fetch(`/api/payments/${paymentId}/receipts`, { method: "POST", body: new FormData(e.currentTarget) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setError(body.error ?? "Upload failed.");
      ref.current?.reset();
      setOk("Evidence uploaded.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={ref} onSubmit={submit} className="space-y-3 rounded-md border bg-muted/30 p-3">
      <FormAlert error={error} message={ok} />
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <Label htmlFor="kind">Evidence type</Label>
          <Select id="kind" name="kind" defaultValue={wire ? "bank_confirmation" : "receipt"}>
            {RECEIPT_KINDS.filter((k) => k !== "provider_callback").map((k) => (
              <option key={k} value={k}>
                {RECEIPT_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="file">File (PDF, PNG, JPG, DOCX, XLSX; max 15 MB)</Label>
          <Input id="file" name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xlsx" className="h-auto py-1.5" />
        </div>
      </div>
      <Input name="note" placeholder="Note (optional)" maxLength={300} />
      <Button type="submit" size="sm" variant="secondary" disabled={busy}>
        <Upload className="h-3.5 w-3.5" /> {busy ? "Uploading…" : "Upload evidence"}
      </Button>
    </form>
  );
}
