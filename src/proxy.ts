import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/verify-otp", "/forgot-password"];

/**
 * Cheap first gate: no session cookie → send to /login. The real authorization check
 * (valid session, active user, RBAC) always happens server-side in layouts, route handlers and actions.
 * Webhook endpoints (and /api/cron/tick, which checks a bearer CRON_SECRET) are public here but authenticate themselves.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const res = (() => {
    if (PUBLIC.some((p) => pathname === p) || pathname.startsWith("/api/integrations/") || pathname === "/api/cron/tick") return NextResponse.next();
    if (!req.cookies.get("crm_session")?.value) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
      }
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  })();
  res.headers.set("x-correlation-id", req.headers.get("x-correlation-id") ?? crypto.randomUUID());
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
