import { connectDb } from "@/lib/db/connect";
import { MonthlyReview } from "@/lib/db/models/monthly-review";
import type { ITask } from "@/lib/db/models/task";

/**
 * The Task is the source of truth for a monthly review; `monthly_reviews` mirrors status / due date / checklist /
 * reviewer so the tracker and reports can be queried without joining. Call after every change to a monthly task.
 */
export async function syncReviewFromTask(task: Pick<ITask, "_id" | "kind" | "status" | "dueDate" | "checklist" | "completedBy">) {
  if (task.kind !== "monthly_review") return;
  await connectDb();
  await MonthlyReview.updateOne(
    { taskId: task._id },
    {
      $set: {
        status: task.status,
        dueDate: task.dueDate,
        checklist: task.checklist.map((c) => ({ label: c.label, done: !!c.done })),
        reviewerId: task.completedBy ?? null,
      },
    },
  );
}
