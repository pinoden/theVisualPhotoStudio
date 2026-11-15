import { LABEL_TEXT, type LabelKey } from "@/lib/domain/labels";

/** The small badge that shows an appointment's status label. Each label has its own colour (globals.css). */
export function StatusBadge({ label }: { label: LabelKey }) {
  return <span className={`status-badge status-${label}`}>{LABEL_TEXT[label]}</span>;
}
