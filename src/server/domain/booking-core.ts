import { and, asc, eq, sql } from "drizzle-orm";
import { bookings, corporateBookings, memberships, companies, checkins } from "@/db/schema";
import type { db as DbType } from "@/db";

/**
 * Plans/pools with this many credits (or more) are treated as unlimited
 * and never decrement. Historically this constant was duplicated
 * implicitly between bookings.ts and corporate-bookings.ts; it now lives
 * in one place. See behavior-inventory.md finding 10.
 */
export const UNLIMITED_CREDITS = 999;

export function hoursUntil(iso: string, now = new Date()): number {
  return (new Date(iso).getTime() - now.getTime()) / 36e5;
}

/**
 * Identifies where a booking's credits come from. A personal booking is
 * tied to a membership; a corporate booking is tied to a company's
 * shared credit pool. Kept as a small discriminated union rather than
 * merging the two tables — see refactor-decisions.md for why we chose
 * to unify behavior without unifying schema.
 */
export type CreditSource =
  | { kind: "membership"; membershipId: number }
  | { kind: "company"; companyId: number };

/**
 * Counts CONFIRMED (status = 'booked') attendees for a class across
 * BOTH personal and corporate bookings combined. This is the fix for
 * behavior-inventory.md finding 1: previously each router only counted
 * its own table, so a room could be double-booked across both flows.
 */
export async function confirmedCount(
  db: typeof DbType,
  classId: number,
): Promise<number> {
  const [personal] = await db
    .select({ c: sql<number>`count(*)` })
    .from(bookings)
    .where(and(eq(bookings.classId, classId), eq(bookings.status, "booked")));

  const [corporate] = await db
    .select({ c: sql<number>`count(*)` })
    .from(corporateBookings)
    .where(
      and(
        eq(corporateBookings.classId, classId),
        eq(corporateBookings.status, "booked"),
      ),
    );

  return Number(personal?.c ?? 0) + Number(corporate?.c ?? 0);
}

export async function isClassFull(
  db: typeof DbType,
  classId: number,
  capacity: number,
): Promise<boolean> {
  return (await confirmedCount(db, classId)) >= capacity;
}

/**
 * Counts check-ins for a class across BOTH personal and corporate
 * bookings. Fix for behavior-inventory.md finding 2: corporate
 * check-ins previously always left checkins.bookingId null, so a plain
 * join on bookingId (the old checkinCountFor implementation) silently
 * missed every corporate attendee. Now that corporate check-ins set
 * checkins.corporateBookingId instead, this counts both and sums them.
 */
export async function checkinCountForClass(
  db: typeof DbType,
  classId: number,
): Promise<number> {
  const [personal] = await db
    .select({ c: sql<number>`count(*)` })
    .from(checkins)
    .innerJoin(bookings, eq(checkins.bookingId, bookings.id))
    .where(eq(bookings.classId, classId));

  const [corporate] = await db
    .select({ c: sql<number>`count(*)` })
    .from(checkins)
    .innerJoin(corporateBookings, eq(checkins.corporateBookingId, corporateBookings.id))
    .where(eq(corporateBookings.classId, classId));

  return Number(personal?.c ?? 0) + Number(corporate?.c ?? 0);
}

/** Reads the current balance for a credit source. */
async function getBalance(db: typeof DbType, source: CreditSource): Promise<number> {
  if (source.kind === "membership") {
    const row = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, source.membershipId))
      .get();
    return row?.creditsRemaining ?? 0;
  }
  const row = await db
    .select()
    .from(companies)
    .where(eq(companies.id, source.companyId))
    .get();
  return row?.creditPoolBalance ?? 0;
}

/**
 * Only memberships have an "unlimited" concept (creditsRemaining >=
 * UNLIMITED_CREDITS). Corporate credit pools never are — this matches
 * current behavior exactly; there's no equivalent sentinel for
 * companies anywhere in the existing code.
 */
async function isUnlimited(db: typeof DbType, source: CreditSource): Promise<boolean> {
  if (source.kind !== "membership") return false;
  return (await getBalance(db, source)) >= UNLIMITED_CREDITS;
}

/**
 * Deducts `amount` credits from a source, skipping entirely if the
 * source is an unlimited membership. Floors at 0 rather than going
 * negative. Used both at initial booking time (where the router has
 * already confirmed sufficient balance, so flooring never actually
 * triggers) and at promotion time (where it can, intentionally — see
 * behavior-inventory.md finding 15 and the decision in
 * refactor-decisions.md to unify on this floor-at-zero policy).
 */
export async function chargeCredits(
  db: typeof DbType,
  source: CreditSource,
  amount: number,
): Promise<void> {
  if (await isUnlimited(db, source)) return;
  const balance = await getBalance(db, source);
  const next = Math.max(0, balance - amount);
  if (source.kind === "membership") {
    await db
      .update(memberships)
      .set({ creditsRemaining: next })
      .where(eq(memberships.id, source.membershipId));
  } else {
    await db
      .update(companies)
      .set({ creditPoolBalance: next })
      .where(eq(companies.id, source.companyId));
  }
}

/** Mirrors chargeCredits: adds `amount` back, skipping unlimited memberships. */
export async function refundCredits(
  db: typeof DbType,
  source: CreditSource,
  amount: number,
): Promise<void> {
  if (await isUnlimited(db, source)) return;
  const balance = await getBalance(db, source);
  const next = balance + amount;
  if (source.kind === "membership") {
    await db
      .update(memberships)
      .set({ creditsRemaining: next })
      .where(eq(memberships.id, source.membershipId));
  } else {
    await db
      .update(companies)
      .set({ creditPoolBalance: next })
      .where(eq(companies.id, source.companyId));
  }
}

export type PromotionResult =
  | { kind: "personal"; bookingId: number }
  | { kind: "corporate"; bookingId: number }
  | null;

/**
 * Promotes whichever waitlisted booking has waited longest for this
 * class, considering BOTH personal and corporate waitlists together
 * (fix for finding 1/5: capacity and the waitlist are one shared
 * concept now, not two separate per-table ones). Charges credits using
 * the unified floor-at-zero policy (fix for finding 15). Returns which
 * booking was promoted, or null if nobody was waiting.
 */
export async function promoteNextWaitlisted(
  db: typeof DbType,
  cls: { id: number; creditCost: number },
): Promise<PromotionResult> {
  const [personalNext] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.classId, cls.id), eq(bookings.status, "waitlisted")))
    .orderBy(asc(bookings.bookedAt))
    .limit(1);

  const [corporateNext] = await db
    .select()
    .from(corporateBookings)
    .where(
      and(
        eq(corporateBookings.classId, cls.id),
        eq(corporateBookings.status, "waitlisted"),
      ),
    )
    .orderBy(asc(corporateBookings.bookedAt))
    .limit(1);

  let winner: { kind: "personal" | "corporate"; row: typeof personalNext | typeof corporateNext } | null =
    null;

  if (personalNext && corporateNext) {
    winner =
      new Date(personalNext.bookedAt) <= new Date(corporateNext.bookedAt)
        ? { kind: "personal", row: personalNext }
        : { kind: "corporate", row: corporateNext };
  } else if (personalNext) {
    winner = { kind: "personal", row: personalNext };
  } else if (corporateNext) {
    winner = { kind: "corporate", row: corporateNext };
  }

  if (!winner) return null;

  if (winner.kind === "personal") {
    const row = winner.row as typeof personalNext;
    await db
      .update(bookings)
      .set({ status: "booked", creditsUsed: cls.creditCost })
      .where(eq(bookings.id, row.id));

    if (row.membershipId) {
      await chargeCredits(
        db,
        { kind: "membership", membershipId: row.membershipId },
        cls.creditCost,
      );
    }
    return { kind: "personal", bookingId: row.id };
  } else {
    const row = winner.row as typeof corporateNext;
    await db
      .update(corporateBookings)
      .set({ status: "booked", creditsUsed: cls.creditCost })
      .where(eq(corporateBookings.id, row.id));

    await chargeCredits(db, { kind: "company", companyId: row.companyId }, cls.creditCost);
    return { kind: "corporate", bookingId: row.id };
  }
}

export type CancelClassResult = {
  refundedPersonal: number;
  refundedCorporate: number;
  waitlistedCleared: number;
};

/**
 * Called when a class itself is cancelled by the studio (classes.cancel),
 * as opposed to a member cancelling their own booking. Handles BOTH
 * personal and corporate bookings for the class, consistently:
 *
 *  - Confirmed ('booked') rows are marked cancelled AND refunded — a
 *    member shouldn't lose credits for a cancellation that wasn't their
 *    choice. No time-window check applies here (unlike a member-initiated
 *    cancel), since the studio cancelling isn't something the member
 *    could have acted on sooner.
 *  - Waitlisted rows are marked cancelled too, with no refund needed
 *    (they were never charged). Previously these were left completely
 *    untouched, permanently stuck "waitlisted" for a class that no
 *    longer exists — see behavior-inventory.md finding 4.
 *
 * There is no waitlist promotion here — the class itself is gone, so
 * there's nothing left to be promoted into.
 */
export async function cancelClassBookings(
  db: typeof DbType,
  cls: { id: number; creditCost: number },
): Promise<CancelClassResult> {
  const bookedPersonal = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.classId, cls.id), eq(bookings.status, "booked")));

  const bookedCorporate = await db
    .select()
    .from(corporateBookings)
    .where(and(eq(corporateBookings.classId, cls.id), eq(corporateBookings.status, "booked")));

  const waitlistedPersonal = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.classId, cls.id), eq(bookings.status, "waitlisted")));

  const waitlistedCorporate = await db
    .select()
    .from(corporateBookings)
    .where(and(eq(corporateBookings.classId, cls.id), eq(corporateBookings.status, "waitlisted")));

  const now = new Date().toISOString();

  for (const row of bookedPersonal) {
    await db
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: now })
      .where(eq(bookings.id, row.id));
    if (row.membershipId && row.creditsUsed > 0) {
      await refundCredits(db, { kind: "membership", membershipId: row.membershipId }, row.creditsUsed);
    }
  }

  for (const row of bookedCorporate) {
    await db
      .update(corporateBookings)
      .set({ status: "cancelled", cancelledAt: now })
      .where(eq(corporateBookings.id, row.id));
    if (row.creditsUsed > 0) {
      await refundCredits(db, { kind: "company", companyId: row.companyId }, row.creditsUsed);
    }
  }

  for (const row of waitlistedPersonal) {
    await db
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: now })
      .where(eq(bookings.id, row.id));
  }

  for (const row of waitlistedCorporate) {
    await db
      .update(corporateBookings)
      .set({ status: "cancelled", cancelledAt: now })
      .where(eq(corporateBookings.id, row.id));
  }

  return {
    refundedPersonal: bookedPersonal.length,
    refundedCorporate: bookedCorporate.length,
    waitlistedCleared: waitlistedPersonal.length + waitlistedCorporate.length,
  };
}
