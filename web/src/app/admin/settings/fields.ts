import type { MoneySettingKey, NumberSettingKey } from "@/server/settings";

/** A whole number of the Settings page, or an amount of money (`money`), typed in dollars and kept in cents. */
export type SettingField = { key: NumberSettingKey; label: string; help: string; money?: undefined } | { key: MoneySettingKey; label: string; help: string; money: true };

/** The numbers of the Settings page, in its groups, with the words the page shows for each. */
export const SETTING_GROUPS: { title: string; fields: SettingField[] }[] = [
  {
    title: "Booking",
    fields: [
      { key: "minLeadHours", label: "Minimum notice (hours)", help: "How far ahead a booking must be made." },
      { key: "maxAdvanceDays", label: "Booking horizon (days)", help: "How far ahead the calendar is open." },
      { key: "photoMinLeadHours", label: "Minimum notice for photography (hours)", help: "336 is two weeks. A session with the photographer cannot be booked closer than this." },
      { key: "slotIncrementMinutes", label: "Start times every (minutes)", help: "15 offers 9:00, 9:15, 9:30 and so on." },
      { key: "holdMinutes", label: "Hold while paying (minutes)", help: "How long a slot is kept for a customer at checkout." },
      {
        key: "twoStudioGuestLimit",
        label: "Most guests for two studios together",
        help: "Every guest counts, those included and the extra ones. Each studio's included and extra guests are set under Studios.",
      },
      { key: "threeStudioGuestLimit", label: "Most guests for all three studios", help: "Every guest counts, as above." },
    ],
  },
  {
    title: "Cancelling and rescheduling",
    fields: [
      { key: "refundWindowHours", label: "Refund window (hours before start)", help: "168 is 7 days. Earlier cancellations are refunded automatically." },
      { key: "photoRefundWindowHours", label: "Refund window for photography (hours before start)", help: "336 is 14 days." },
      { key: "refundFeePercent", label: "Processing fee kept (%)", help: "0 refunds in full." },
      { key: "rescheduleCutoffHours", label: "Reschedule cut-off (hours before start)", help: "After this, customers must call." },
      { key: "maxReschedules", label: "Free reschedules per booking", help: "0 switches reschedule codes off." },
      {
        key: "rescheduleFeeCents",
        label: "Fee for each further reschedule ($)",
        help: "Taken off the reschedule code. With 0, a booking cannot be moved online again after the free ones.",
        money: true,
      },
      { key: "creditValidDays", label: "Reschedule code valid for (days)", help: "" },
    ],
  },
  {
    title: "Loyalty: a free hour for regular visitors",
    fields: [
      { key: "loyaltyVisits", label: "Visits that earn a free hour", help: "Counted on separate days. A visit made with a free hour does not count." },
      { key: "loyaltyValidDays", label: "Free hour valid for (days)", help: "" },
      { key: "loyaltyDelayHours", label: "A visit counts after (hours)", help: "Time after the visit ends, so staff can mark a no-show first." },
    ],
  },
];

/** What the Settings page calls a number, for a message about it. */
export function settingLabel(key: NumberSettingKey | MoneySettingKey): string {
  for (const group of SETTING_GROUPS) {
    const field = group.fields.find((entry) => entry.key === key);
    if (field) return field.label;
  }
  return key;
}
