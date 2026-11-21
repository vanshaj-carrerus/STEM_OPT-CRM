import { NextResponse, type NextRequest } from "next/server";
import { paymentRoute } from "@/lib/payments/route";
import { readReceiptByToken } from "@/lib/payments/receipts";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/payments/receipts/download?token=… — token minted by the permission-checked `mintReceiptDownloadAction`
 * (60 s, bound to the minting user). Access is re-checked here; every download is audited.
 */
export const GET = paymentRoute(async (user, req: NextRequest) => {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const { receipt, data } = await readReceiptByToken(user, token);
  await audit({
    actor: user, action: "download", entityType: "payment_receipt", entityId: receipt._id, candidateId: receipt.candidateId,
    summary: `Downloaded ${receipt.kind} for payment ${receipt.paymentId}`, after: { fileName: receipt.fileName, sha256: receipt.sha256 },
  });
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": receipt.contentType,
      "Content-Disposition": `attachment; filename="${receipt.fileName.replace(/["\\\r\n]/g, "_")}"`,
      "Content-Length": String(data.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
