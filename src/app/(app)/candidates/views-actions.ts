"use server";

import { revalidate as revalidatePath } from "@/lib/request-context";
import { z } from "zod";
import { requireAction } from "@/lib/auth/guard";
import { connectDb } from "@/lib/db/connect";
import { SavedView } from "@/lib/db/models/saved-view";

export async function saveViewAction(fd: FormData) {
  const u = await requireAction("candidates.view");
  const p = z.object({ name: z.string().trim().min(1).max(60), query: z.string().max(1000) }).safeParse({
    name: fd.get("name"),
    query: fd.get("query") ?? "",
  });
  if (!p.success) return;
  // strip pagination from the stored query so the view always opens on page 1
  const q = new URLSearchParams(p.data.query);
  q.delete("page");
  await connectDb();
  await SavedView.updateOne(
    { userId: u.id, module: "candidates", name: p.data.name },
    { $set: { query: q.toString() } },
    { upsert: true },
  );
  revalidatePath("/candidates");
}

export async function deleteViewAction(fd: FormData) {
  const u = await requireAction("candidates.view");
  await connectDb();
  await SavedView.deleteOne({ _id: String(fd.get("id")), userId: u.id });
  revalidatePath("/candidates");
}
