import { type NextRequest } from "next/server";
import { apiError, route } from "@/lib/api";
import { audit } from "@/lib/audit";
import { verifyDownloadToken } from "@/lib/storage";
import { canPreviewInline, contentDisposition } from "@/lib/documents/rules";
import { DocumentError, getDownloadableDocument, readDocumentBytes } from "@/lib/documents/service";
import { DOCUMENT_TYPE_MAP } from "@/lib/documents/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/documents/{id}/download?token=...[&inline=1]
 * The token (minted by the `requestDownloadUrl` action, 60 s TTL) must verify, name this document and this very
 * session user. Permission, record-level access and the restricted flag are re-checked here, the access is audited
 * BEFORE any bytes are released, and the file is streamed decrypted with hardening headers.
 */
export const GET = route(
  async (user, req: NextRequest, ctx: Ctx) => {
    const { id } = await ctx.params;
    const claims = verifyDownloadToken(req.nextUrl.searchParams.get("token") ?? "");
    if (!claims || claims.id !== id || claims.uid !== user.id) return apiError(403, "This download link is invalid or has expired.");

    try {
      const doc = await getDownloadableDocument(user, id);
      const inline = req.nextUrl.searchParams.get("inline") === "1";
      if (inline && !canPreviewInline(doc.contentType)) return apiError(422, "This file type cannot be previewed.");

      const bytes = await readDocumentBytes(doc);
      await audit({
        actor: user,
        action: "download",
        entityType: "document",
        entityId: doc._id,
        candidateId: doc.candidateId,
        source: "api",
        summary: `${inline ? "Previewed" : "Downloaded"} ${DOCUMENT_TYPE_MAP[doc.type]?.label ?? doc.type} v${doc.version} (${doc.fileName})`,
        after: { version: doc.version, sha256: doc.sha256, inline },
      });

      const headers: Record<string, string> = {
        "Content-Type": inline ? doc.contentType : "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Content-Disposition": contentDisposition(doc.fileName, inline),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      };
      if (inline) headers["Content-Security-Policy"] = "sandbox";
      return new Response(new Uint8Array(bytes), { headers });
    } catch (e) {
      if (e instanceof DocumentError) return apiError(e.status, e.message);
      throw e;
    }
  },
  { limitPerMin: 60 },
);
