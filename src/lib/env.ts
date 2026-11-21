import { z } from "zod";

const schema = z.object({
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DB: z.string().default("stem_opt_crm"),
  /** 32+ byte secret (base64 or hex or any long string). Used to derive encryption + HMAC keys. */
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters"),
  APP_URL: z.string().default("http://localhost:3000"),
  /** Gmail account used to send OTP / reminder emails (Gmail app password). Empty in dev = emails print to the console. */
  EMAIL_USER: z.preprocess((v) => (v === "" ? undefined : v), z.string().email().optional()),
  EMAIL_PASS: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  /** "console" forces development mode to print emails instead of sending them (used by test servers). Ignored in production. */
  MAIL_MODE: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["gmail", "console"]).optional()),
  /** Alias of EMAIL_PASS (either name works; EMAIL_PASS wins if both are set). */
  EMAIL_PASSWORD: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  DOCS_DIR: z.string().default("./.data/documents"),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  /** First Super Admin password — any non-empty value is accepted (no complexity rules for the system admin). */
  SEED_ADMIN_PASSWORD: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  /** Bearer token guarding POST /api/cron/tick for serverless schedulers (optional; endpoint is disabled without it). */
  CRON_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16, "CRON_SECRET must be at least 16 characters").optional()),
  SEED_ADMIN_NAME: z.string().default("System Administrator"),
  /** Shared secret for verifying Gusto webhook signatures (optional; the webhook endpoint rejects everything without it). */
  GUSTO_WEBHOOK_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16, "GUSTO_WEBHOOK_SECRET must be at least 16 characters").optional()),
  /** Shared secret for verifying Ria webhook signatures (optional; the endpoint is disabled/ignored without Ria approval + this secret). */
  RIA_WEBHOOK_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16, "RIA_WEBHOOK_SECRET must be at least 16 characters").optional()),
  /** Shared secret for verifying bank event signatures (optional; manual reconciliation is the default). */
  BANK_WEBHOOK_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16, "BANK_WEBHOOK_SECRET must be at least 16 characters").optional()),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  cached = parsed.data;
  return cached;
}
