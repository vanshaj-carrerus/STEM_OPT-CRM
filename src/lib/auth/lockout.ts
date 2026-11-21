import { connectDb } from "@/lib/db/connect";
import { User } from "@/lib/db/models/user";

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

/**
 * ONE message for every way a sign-in can fail (unknown email, wrong password, locked account, disabled account), so the
 * response never reveals whether an address has an account or whether it is locked.
 */
export const LOGIN_FAILED_MESSAGE = `Incorrect email or password. After ${MAX_FAILED_LOGINS} failed attempts an account is locked for ${LOCK_MINUTES} minutes.`;

export interface LockoutState {
  failedLogins: number;
  lockedUntil: Date | null;
  /** true when THIS attempt is the one that triggered the lock */
  justLocked: boolean;
}

export const isLocked = (u: { lockedUntil?: Date | null }, now = new Date()) => !!u.lockedUntil && u.lockedUntil.getTime() > now.getTime();

/**
 * Record one failed password attempt — atomically, in a single database operation (no read-then-write gap, so parallel
 * guesses can neither undercount nor extend each other's lock):
 *  - already locked            → nothing changes (a lock is never extended by more guesses)
 *  - previous lock has EXPIRED → counting restarts at 1 (a single typo after a lock does not instantly re-lock)
 *  - otherwise                 → counter + 1; reaching MAX_FAILED_LOGINS sets lockedUntil = now + 15 minutes
 */
export async function registerFailedLogin(userId: string, now = new Date()): Promise<LockoutState> {
  await connectDb();
  const lockDate = new Date(now.getTime() + LOCK_MINUTES * 60_000);
  const doc = await User.findOneAndUpdate(
    { _id: userId },
    [
      {
        $set: {
          failedLogins: {
            $cond: [
              { $gt: ["$lockedUntil", now] },
              "$failedLogins",
              {
                $cond: [
                  { $and: [{ $ne: [{ $type: "$lockedUntil" }, "missing"] }, { $ne: ["$lockedUntil", null] }] },
                  1,
                  { $add: [{ $ifNull: ["$failedLogins", 0] }, 1] },
                ],
              },
            ],
          },
        },
      },
      {
        $set: {
          lockedUntil: {
            $cond: [{ $gt: ["$lockedUntil", now] }, "$lockedUntil", { $cond: [{ $gte: ["$failedLogins", MAX_FAILED_LOGINS] }, lockDate, null] }],
          },
        },
      },
    ],
    { returnDocument: "after", updatePipeline: true },
  ).lean<{ failedLogins: number; lockedUntil: Date | null }>();
  const lockedUntil = doc?.lockedUntil ?? null;
  return {
    failedLogins: doc?.failedLogins ?? 0,
    lockedUntil,
    justLocked: !!lockedUntil && lockedUntil.getTime() === lockDate.getTime(),
  };
}

export async function clearFailedLogins(userId: string) {
  await connectDb();
  await User.updateOne({ _id: userId }, { $set: { failedLogins: 0, lockedUntil: null } });
}
