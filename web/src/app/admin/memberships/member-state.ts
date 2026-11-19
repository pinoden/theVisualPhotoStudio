import { longDateLabel } from "@/lib/domain/time";
import type { MemberRow } from "@/server/memberships";

/** A membership's state in a word or two, as the owners' pages show it. */
export const MEMBER_STATE: Record<MemberRow["status"], string> = {
  starting: "Being set up",
  active: "Active",
  cancelled: "Cancelled",
  stopped: "Stopped",
  failed: "Not started",
};

/** When it is billed next, or until when it was paid for. */
export function nextOf(member: MemberRow, today: string): string {
  if (member.nextBilling) return `Next billed ${longDateLabel(member.nextBilling)}`;
  if (member.endsOn) return member.endsOn > today ? `Paid until ${longDateLabel(member.endsOn)}` : `Ended ${longDateLabel(member.endsOn)}`;
  return "";
}
