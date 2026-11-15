"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { isIsoDate } from "@/lib/domain/time";
import { requireStaff } from "@/server/session";
import { setAttendance } from "@/server/staff";

const REASON_TEXT: Record<string, string> = {
  forbidden: "That booking is not on a day assigned to you.",
  not_found: "Booking not found.",
  too_early: "Attendance can be recorded once the booking has started.",
  not_changeable: "That booking was cancelled.",
};

/** Record whether a customer came. setAttendance checks the viewer's shift itself. */
export async function attendanceAction(formData: FormData): Promise<void> {
  const date = String(formData.get("date") ?? "");
  const back = `/staff${isIsoDate(date) ? `?date=${date}` : ""}`;
  const viewer = await requireStaff(back);
  const status = formData.get("status");
  if (status !== "completed" && status !== "no_show" && status !== "confirmed") redirect(back);

  const result = await setAttendance(await getDb(), viewer, String(formData.get("ref") ?? ""), status, new Date());
  const separator = back.includes("?") ? "&" : "?";
  redirect(result.ok ? back : `${back}${separator}error=${encodeURIComponent(REASON_TEXT[result.reason] ?? "Not possible.")}`);
}
