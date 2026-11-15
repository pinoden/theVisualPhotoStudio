"use server";

import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { taskDeps } from "@/server/runtime";
import { runScheduledTasks } from "@/server/tasks";

/** Development only: run the recurring jobs now instead of waiting for the scheduler. */
export async function runTasksNowAction(): Promise<void> {
  if (process.env.NODE_ENV === "production") notFound();
  const summary = await runScheduledTasks(await getDb(), await taskDeps());
  redirect(`/dev/outbox?ran=${encodeURIComponent(JSON.stringify(summary))}`);
}
