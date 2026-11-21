import { ShieldCheck } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div className="leading-tight">
            <p className="text-base font-semibold">Compliance CRM</p>
            <p className="text-xs text-muted-foreground">STEM OPT &amp; CPT management</p>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-6 shadow-sm">{children}</div>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Authorized personnel only. Activity is logged.
        </p>
      </div>
    </main>
  );
}
