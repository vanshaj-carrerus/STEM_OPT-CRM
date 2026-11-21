import { connectDb } from "@/lib/db/connect";
import { env } from "@/lib/env";
import { sendMail } from "@/lib/mail";
import { getSetting } from "@/lib/settings";
import { addDays, todayIn, type DateOnly } from "@/lib/compliance/dates";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { AuditEvent } from "@/lib/db/models/audit";
import { NotificationLog, Reminder, MAX_REMINDER_ATTEMPTS, type IReminder } from "@/lib/db/models/reminder";
import { Task, OPEN_TASK_STATUSES, type ITask } from "@/lib/db/models/task";
import { User, type IUser } from "@/lib/db/models/user";
import { Notification } from "@/lib/db/models/notification";
import { ensureTrackerCycles } from "@/lib/tracker/service";
import { escalateStaleEmergencies } from "@/lib/payroll/emergency";
import { regenerateSchedule } from "@/lib/immigration/schedule";
import { planReminders, sanitizeOffsets, type PlanCandidate, type PlanTask, type PlanUser, type PlannedReminder } from "./plan";
import { resolveTimezone } from "./timezone";

/**
 * Daily reminder / escalation job (AC-08). Idempotent: running it twice in a day sends nothing new.
 *
 *  1. plan   — pure function over open tasks, existing reminder keys, users, holidays, "today" per record timezone
 *  2. insert — INSERT the reminder row first; the UNIQUE key means exactly one worker wins (duplicate key ⇒ skip)
 *  3. send   — only the winner sends; failures are logged and retried by later runs (bounded attempts)
 */

export interface RunOptions {
  now?: Date;
  /** Called with paths whose cached data changed (the cron route passes next/cache revalidatePath). Never throws into the job. */
  revalidate?: (paths: string[]) => void;
  log?: (msg: string) => void;
}

export interface RunSummary {
  tasksScanned: number;
  planned: number;
  sent: number;
  skipped: number;
  duplicates: number;
  failed: number;
  retried: number;
  escalations: number;
  cyclesStarted: number;
  /** Action-Required emergency payroll items bumped to the next escalation level. */
  emergenciesEscalated?: number;
  /** Candidates whose milestones / clearance / risk flags were re-derived (expired authorizations revoke clearance). */
  schedulesRefreshed?: number;
}

const STALE_PENDING_MS = 30 * 60_000;
const RETRY_WINDOW_DAYS = 3;
const DUP = 11000;

let inFlight: Promise<RunSummary> | null = null;

/** Single entry point for the worker, the cron route and tests. Overlapping calls in one process share one run. */
export function runDailyJob(opts: RunOptions = {}): Promise<RunSummary> {
  if (inFlight) return inFlight;
  inFlight = run(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(opts: RunOptions): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => undefined);
  await connectDb();
  const summary: RunSummary = { tasksScanned: 0, planned: 0, sent: 0, skipped: 0, duplicates: 0, failed: 0, retried: 0, escalations: 0, cyclesStarted: 0 };

  try {
    summary.cyclesStarted = await ensureTrackerCycles();
  } catch (e) {
    log(`tracker cycle step failed: ${errMsg(e)}`);
  }

  try {
    summary.emergenciesEscalated = await escalateStaleEmergencies(now);
  } catch (e) {
    log(`emergency escalation step failed: ${errMsg(e)}`);
  }

  // Daily re-derivation so an authorization that expired overnight revokes clearance without anyone clicking.
  try {
    const rows = await Candidate.find({ stage: { $in: ["onboarding", "active", "on_hold"] }, authType: { $ne: "none" } })
      .select("_id")
      .limit(5000)
      .lean<{ _id: string }[]>();
    let n = 0;
    for (const r of rows) {
      try {
        await regenerateSchedule({ actor: null, candidateId: r._id, today: undefined });
        n++;
      } catch (e) {
        log(`schedule refresh failed for ${r._id}: ${errMsg(e)}`);
      }
    }
    summary.schedulesRefreshed = n;
  } catch (e) {
    log(`schedule refresh step failed: ${errMsg(e)}`);
  }

  const [offsets, byType, holidays, staffEmailEnabled, candidateEmailEnabled] = await Promise.all([
    getSetting("reminders.offsets"),
    getSetting("reminders.offsetsByTaskType"),
    getSetting("reminders.holidays"),
    getSetting("reminders.emailEnabled"),
    getSetting("reminders.candidateEmailEnabled"),
  ]);
  const maxOffset = Math.max(0, ...sanitizeOffsets(offsets), ...Object.values(byType ?? {}).flatMap((o) => sanitizeOffsets(o)));
  const utcToday = now.toISOString().slice(0, 10);
  const horizon = addDays(utcToday, maxOffset + 2); // +2 covers timezones ahead of UTC

  const [users, tasks] = await Promise.all([
    User.find({}).select("name email role active teamLeadId timezone").lean<IUser[]>(),
    Task.find({ status: { $in: OPEN_TASK_STATUSES }, dueDate: { $lte: horizon } }).lean<ITask[]>(),
  ]);
  const candidateIds = [...new Set(tasks.map((t) => t.candidateId).filter((x): x is string => !!x))];
  const candidates = candidateIds.length
    ? await Candidate.find({ _id: { $in: candidateIds }, stage: { $ne: "archived" } }).select("legalName email ownerId timezone").lean<ICandidate[]>()
    : [];
  const candMap = new Map<string, PlanCandidate>(candidates.map((c) => [c._id, { id: c._id, name: c.legalName, email: c.email, ownerId: c.ownerId }]));
  const candTz = new Map(candidates.map((c) => [c._id, c.timezone]));
  const userMap = new Map<string, PlanUser>(users.map((u) => [u._id, { id: u._id, role: u.role, active: u.active, teamLeadId: u.teamLeadId }]));
  const userDoc = new Map(users.map((u) => [u._id, u]));

  // tasks of archived/missing candidates are skipped; "today" is computed per record timezone
  const todayCache = new Map<string, DateOnly>();
  const planTasks: PlanTask[] = [];
  for (const t of tasks) {
    if (t.candidateId && !candMap.has(t.candidateId)) continue;
    const cand = t.candidateId ? candMap.get(t.candidateId) : undefined;
    const ownerTz = userDoc.get(t.ownerId ?? cand?.ownerId ?? "")?.timezone;
    const tz = resolveTimezone(t.candidateId ? candTz.get(t.candidateId) : undefined, ownerTz);
    let today = todayCache.get(tz);
    if (!today) {
      today = todayIn(tz, now);
      todayCache.set(tz, today);
    }
    planTasks.push({
      id: t._id, candidateId: t.candidateId, kind: t.kind, refKey: t.refKey, title: t.title, dueDate: t.dueDate, status: t.status,
      ownerId: t.ownerId, escalationLevel: t.escalationLevel, meta: t.meta, today,
    });
  }
  summary.tasksScanned = planTasks.length;

  const existingKeys = new Set<string>();
  const ids = planTasks.map((t) => t.id);
  for (let i = 0; i < ids.length; i += 2000) {
    const rows = await Reminder.find({ taskId: { $in: ids.slice(i, i + 2000) } }).select("key").lean<{ key: string }[]>();
    for (const r of rows) existingKeys.add(r.key);
  }

  const plan = planReminders({
    tasks: planTasks, candidates: candMap, users: userMap, existingKeys,
    offsets, offsetsByTaskType: byType, holidays: new Set(holidays ?? []), staffEmailEnabled, candidateEmailEnabled,
  });
  summary.planned = plan.length;

  const emailOf = (id: string) => userDoc.get(id)?.email;
  for (const p of plan) {
    try {
      await execute(p, emailOf, summary, now);
    } catch (e) {
      summary.failed++;
      log(`reminder ${p.key} failed unexpectedly: ${errMsg(e)}`);
    }
  }

  try {
    summary.retried = await retryFailed(emailOf, summary, now);
  } catch (e) {
    log(`retry step failed: ${errMsg(e)}`);
  }

  if (summary.sent || summary.skipped || summary.cyclesStarted) {
    try {
      opts.revalidate?.(["/calendar", "/dashboard"]);
    } catch {
      /* revalidation is best-effort; there is no Next request scope inside the standalone worker */
    }
  }
  log(`daily job: ${JSON.stringify(summary)}`);
  return summary;
}

/* ------------------------------ execution ------------------------------ */

async function execute(p: PlannedReminder, emailOf: (id: string) => string | undefined, summary: RunSummary, now: Date) {
  const claim = await insertReminder(p);
  if (claim === "duplicate") {
    summary.duplicates++; // another worker (or an earlier run) already owns this key — never send twice
    return;
  }
  if (p.mode === "skip") {
    summary.skipped++;
    return;
  }
  const status = await deliver(claim, emailOf, now);
  if (status === "sent") {
    summary.sent++;
    if (p.kind === "escalation" && p.channel === "in_app" && p.level !== undefined) {
      summary.escalations++;
      await Task.updateOne({ _id: p.taskId }, { $max: { escalationLevel: p.level }, $set: { lastEscalatedAt: now } });
      await workerAudit(p);
    }
  } else {
    summary.failed++;
  }
}

async function insertReminder(p: PlannedReminder): Promise<IReminder | "duplicate"> {
  try {
    const doc = await Reminder.create({
      key: p.key, candidateId: p.candidateId, taskId: p.taskId, taskType: p.taskType, dueDate: p.dueDate,
      channel: p.channel, audience: p.audience, offset: p.offset, templateKey: p.templateKey,
      status: p.mode === "skip" ? "skipped" : "pending", attempts: 0,
      recipientIds: p.recipientIds, toEmail: p.toEmail ?? null, payload: { ...p.payload, kind: p.kind },
    });
    return doc.toObject() as IReminder;
  } catch (e) {
    if ((e as { code?: number }).code === DUP) return "duplicate";
    throw e;
  }
}

const absolute = (link: string) => (link ? `${env().APP_URL.replace(/\/$/, "")}${link}` : "");

/** Deliver one claimed reminder; logs every recipient and records status/attempts. Resends only to recipients not yet logged as sent. */
async function deliver(r: IReminder, emailOf: (id: string) => string | undefined, now: Date): Promise<"sent" | "failed"> {
  const already = new Set(
    (await NotificationLog.find({ reminderKey: r.key, status: "sent" }).select("to").lean<{ to: string }[]>()).map((l) => l.to),
  );
  const targets = r.audience === "candidate" ? (r.toEmail ? [r.toEmail] : []) : r.recipientIds;
  const errors: string[] = [];

  for (const to of targets) {
    if (already.has(to)) continue;
    try {
      if (r.channel === "in_app") {
        await Notification.create({
          userId: to, title: r.payload.title, body: r.payload.body, link: r.payload.link,
          kind: r.payload.kind === "escalation" ? "escalation" : "reminder",
        });
      } else {
        const address = r.audience === "candidate" ? to : emailOf(to);
        if (!address) throw new Error("recipient has no email address");
        const link = absolute(r.payload.link);
        await sendMail({ to: address, subject: r.payload.subject, text: link ? `${r.payload.body}\n\n${link}` : r.payload.body });
      }
      await writeLog(r, to, "sent");
    } catch (e) {
      errors.push(errMsg(e));
      await writeLog(r, to, "failed", errMsg(e));
    }
  }
  if (!targets.length) errors.push("no recipients");
  const ok = errors.length === 0;
  await Reminder.updateOne(
    { _id: r._id },
    { $set: { status: ok ? "sent" : "failed", sentAt: ok ? now : null, lastError: ok ? undefined : errors.join("; ").slice(0, 500) }, $inc: { attempts: 1 } },
  );
  return ok ? "sent" : "failed";
}

/**
 * Bounded retry: failed reminders (and ones stuck `pending` after a crash) are re-claimed atomically, so two workers
 * never retry the same row. Only recent reminders are retried and only up to MAX_REMINDER_ATTEMPTS.
 */
async function retryFailed(emailOf: (id: string) => string | undefined, summary: RunSummary, now: Date): Promise<number> {
  const since = new Date(now.getTime() - RETRY_WINDOW_DAYS * 86_400_000);
  const stale = new Date(now.getTime() - STALE_PENDING_MS);
  const rows = await Reminder.find({
    createdAt: { $gte: since },
    attempts: { $lt: MAX_REMINDER_ATTEMPTS },
    $or: [{ status: "failed" }, { status: "pending", updatedAt: { $lt: stale } }],
  })
    .limit(500)
    .lean<IReminder[]>();
  let n = 0;
  for (const r of rows) {
    const claimed = await Reminder.findOneAndUpdate(
      { _id: r._id, status: r.status, attempts: r.attempts },
      { $set: { status: "pending" } },
      { returnDocument: "after" },
    ).lean<IReminder>();
    if (!claimed) continue; // someone else took it
    n++;
    const status = await deliver(claimed, emailOf, now);
    if (status === "sent") summary.sent++;
  }
  return n;
}

async function writeLog(r: IReminder, to: string, status: "sent" | "failed", error?: string) {
  await NotificationLog.create({
    audience: r.audience, channel: r.channel, to, templateKey: r.templateKey, status, error: error?.slice(0, 500),
    reminderKey: r.key, taskId: r.taskId, candidateId: r.candidateId, sentAt: new Date(),
  });
}

async function workerAudit(p: PlannedReminder) {
  try {
    await AuditEvent.create({
      source: "worker", entityType: "task", entityId: p.taskId, candidateId: p.candidateId, action: "system",
      summary: `Overdue task escalated (level ${p.level}) — notified ${p.recipientIds.length} user(s)`,
      after: { level: p.level, recipientIds: p.recipientIds },
    });
  } catch {
    /* audit of a system notification must never break the run */
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
