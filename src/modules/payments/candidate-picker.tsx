"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/form";

interface Hit {
  id: string;
  label: string;
}

/** Candidate search-and-select. Uses the record-scoped /api/candidates search; submits the chosen id as `candidateId`. */
export function CandidatePicker({ defaultCandidate, locked, onChange }: { defaultCandidate?: Hit; locked?: boolean; onChange?: (id: string) => void }) {
  const [selected, setSelected] = useState<Hit | null>(defaultCandidate ?? null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onChange?.(selected?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (locked || q.trim().length < 2) {
      setHits([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(`/api/candidates?q=${encodeURIComponent(q.trim())}&pageSize=8`);
        if (res.ok) {
          const data = (await res.json()) as { rows: { _id: string; candidateCode: string; legalName: string }[] };
          setHits(data.rows.map((r) => ({ id: r._id, label: `${r.candidateCode} · ${r.legalName}` })));
        }
      } finally {
        setBusy(false);
      }
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, locked]);

  return (
    <div>
      <input type="hidden" name="candidateId" value={selected?.id ?? ""} />
      {selected ? (
        <div className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-sm">
          <span>{selected.label}</span>
          {!locked && (
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setSelected(null)}>
              Change
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search candidate by name, email or code…" autoComplete="off" aria-label="Search candidates" />
          {(hits.length > 0 || busy) && (
            <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-card text-sm shadow-lg">
              {busy && <li className="px-3 py-2 text-muted-foreground">Searching…</li>}
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left hover:bg-muted"
                    onClick={() => {
                      setSelected(h);
                      setHits([]);
                      setQ("");
                    }}
                  >
                    {h.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
