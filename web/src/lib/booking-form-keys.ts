/**
 * What the booking page and the server share of Booking Forms & Agreements (src/server/booking-forms.ts): the kinds
 * of question, and the keys by which a client's acceptance of a version is sent and checked.
 */

export type QuestionKind = "text" | "checkbox" | "dropdown" | "choice";

/** The website's Policies page, as published in this version. */
export const policiesKey = (versionId: string) => `page:${versionId}`;
/** A version of an agreement beside the policies. */
export const agreementKey = (versionId: string) => `agreement:${versionId}`;
