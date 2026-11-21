import { NextResponse, type NextRequest } from "next/server";
import { paymentRoute } from "@/lib/payments/route";
import { PaymentError } from "@/lib/payments/errors";
import { addReceipt, listReceipts } from "@/lib/payments/receipts";
import { MAX_UPLOAD_BYTES } from "@/lib/storage";

export const dynamic = "force-dynamic";

const publicShape = (r: Awaited<ReturnType<typeof listReceipts>>[number]) => ({
  id: r._id, kind: r.kind, fileName: r.fileName, contentType: r.contentType, sizeBytes: r.sizeBytes, sha256: r.sha256, createdAt: r.createdAt,
});

/** GET /api/payments/:id/receipts — evidence metadata (bytes only via the signed download route). */
export const GET = paymentRoute(async (user, _req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return NextResponse.json((await listReceipts(user, id)).map(publicShape));
});

/** POST /api/payments/:id/receipts — multipart: file, kind (receipt|remittance_advice|bank_confirmation|other), note. Encrypted at rest. */
export const POST = paymentRoute(async (user, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new PaymentError("Choose a file to upload.", 422, "validation", { file: "Required" });
  if (file.size > MAX_UPLOAD_BYTES) throw new PaymentError("File exceeds the 15 MB limit.", 413, "too_large", { file: "Too large" });
  const data = Buffer.from(await file.arrayBuffer());
  // "provider_callback" evidence is created only by verified webhooks, never by a browser upload
  const kind = String(form.get("kind") ?? "receipt");
  if (kind === "provider_callback") throw new PaymentError("Provider callback evidence can only be created by a verified provider event.", 422, "validation", { kind: "Not allowed" });
  const receipt = await addReceipt(user, id, { data, fileName: file.name, kind, note: String(form.get("note") ?? "") || undefined });
  return NextResponse.json(publicShape(receipt), { status: 201 });
});
