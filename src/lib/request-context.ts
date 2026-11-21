import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";

/**
 * The only place the auth layer touches Next's request-scoped `cookies()` / `headers()`.
 * Keeping it behind a tiny local module lets tests substitute a fake request without mocking the framework.
 */
export const requestCookies = () => cookies();
export const requestHeaders = () => headers();
/** Cache revalidation after a mutation (needs a live Next request; faked in tests). */
export const revalidate = (path: string) => revalidatePath(path);
