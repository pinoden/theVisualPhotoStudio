import { desc, eq } from "drizzle-orm";
import { bookings } from "@/db/schema";
import type { DbLike } from "@/db/client";
import type { AuthUser } from "./auth";

/** A signed-in client's own name, email address and phone number, as the booking screen fills them in. */
export interface OwnDetails {
  name: string;
  email: string;
  phone: string;
}

/**
 * What a signed-in client last gave the studio of themselves, for the booking screen to fill in, so that they do not
 * type it again (the owners' decision of 2026-11-27; the preview test of 2026-11-21, point 9): their account's
 * address, and the name and phone number of their latest booking under it, or their account's name when they have
 * none yet.
 *
 * For a customer only. An owner or a staff member on the public booking page is usually booking for someone else, and
 * their own details in the client's fields would end up on that booking. Null for them, and for a visitor.
 */
export async function ownDetails(db: DbLike, user: Pick<AuthUser, "email" | "name" | "role"> | null): Promise<OwnDetails | null> {
  if (!user || user.role !== "customer") return null;
  const [latest] = await db
    .select({ name: bookings.customerName, phone: bookings.customerPhone })
    .from(bookings)
    .where(eq(bookings.customerEmail, user.email))
    .orderBy(desc(bookings.createdAt))
    .limit(1);
  return { name: latest?.name || user.name, email: user.email, phone: latest?.phone ?? "" };
}
