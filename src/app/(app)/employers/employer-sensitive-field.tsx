"use client";

import { useState, useTransition } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { revealEmployerFieldAction } from "./actions";

/** Masked EIN / E-Verify company ID; "Reveal" calls a permission-checked, audit-logged server action. */
export function EmployerSensitiveField({ employerId, field, mask }: { employerId: string; field: "ein" | "everifyCompanyId"; mask?: string }) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!mask) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-sm">{value ?? mask}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label={value ? "Hide value" : "Reveal value (logged)"}
        onClick={() => {
          if (value) return setValue(null);
          start(async () => {
            const r = await revealEmployerFieldAction(employerId, field);
            if (r.error) setError(r.error);
            else {
              setError(null);
              setValue(r.value ?? "");
              setTimeout(() => setValue(null), 30_000); // auto-hide
            }
          });
        }}
      >
        {value ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}
