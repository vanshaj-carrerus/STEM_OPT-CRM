"use client";

import { useState, useTransition } from "react";
import { Download, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestDownloadUrl } from "./actions";

/** Asks the server for a 60-second signed link, then follows it. The file itself never passes through client code. */
export function DownloadButton({ documentId, inline = false, label }: { documentId: string; inline?: boolean; label?: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();

  function go() {
    setError(undefined);
    start(async () => {
      const res = await requestDownloadUrl(documentId, inline);
      if (res.error || !res.url) return setError(res.error ?? "Could not start the download.");
      if (inline) window.open(res.url, "_blank", "noopener,noreferrer");
      else window.location.assign(res.url); // attachment response: the page stays put
    });
  }

  const Icon = inline ? Eye : Download;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button type="button" size="sm" variant="outline" onClick={go} disabled={pending}>
        <Icon className="h-3.5 w-3.5" />
        {pending ? "Preparing…" : (label ?? (inline ? "Preview" : "Download"))}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
