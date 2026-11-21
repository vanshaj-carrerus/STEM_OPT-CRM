import mongoose from "mongoose";
import { env } from "@/lib/env";

type Cache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null };
const g = globalThis as unknown as { __mongoose?: Cache };
const cache: Cache = (g.__mongoose ??= { conn: null, promise: null });

export async function connectDb(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;
  if (!cache.promise) {
    const e = env();
    mongoose.set("strictQuery", true);
    cache.promise = mongoose.connect(e.MONGODB_URI, {
      dbName: e.MONGODB_DB,
      autoIndex: true,
      serverSelectionTimeoutMS: 8000,
    });
  }
  try {
    cache.conn = await cache.promise;
  } catch (err) {
    cache.promise = null;
    throw err;
  }
  return cache.conn;
}
