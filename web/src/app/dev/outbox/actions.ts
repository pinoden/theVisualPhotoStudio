"use server";

import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { mayUseTestTools } from "@/server/browser-test-server";
import { taskDeps } from "@/server/runtime";
import { runScheduledTasks } from "@/server/tasks";

/** Development only (and the browser tests' own server): run the recurring jobs now instead of waiting for the scheduler. */
export async function runTasksNowAction(): Promise<void> {
  if (!mayUseTestTools()) notFound();
  const summary = await runScheduledTasks(await getDb(), await taskDeps());
  redirect(`/dev/outbox?ran=${encodeURIComponent(JSON.stringify(summary))}`);
}
