import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { bookings, corporateBookings, memberships, companies } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resetDb, seedMinimal } from "./helpers";
import {
  confirmedCount,
  isClassFull,
  chargeCredits,
  refundCredits,
  promoteNextWaitlisted,
  cancelClassBookings,
  UNLIMITED_CREDITS,
} from "@/server/domain/booking-core";

describe("confirmedCount / isClassFull", () => {
  it("counts booked rows across BOTH personal and corporate tables combined", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1, member3 } = fixtures.users;
    const { sharedCapacityClass } = fixtures.classes; // capacity 1

    expect(await confirmedCount(db, sharedCapacityClass.id)).toBe(0);
    expect(await isClassFull(db, sharedCapacityClass.id, 1)).toBe(false);

    await db.insert(bookings).values({
      classId: sharedCapacityClass.id,
      userId: member1.id,
      membershipId: fixtures.memberships.membership1.id,
      status: "booked",
      creditsUsed: 1,
    });

    expect(await confirmedCount(db, sharedCapacityClass.id)).toBe(1);
    expect(await isClassFull(db, sharedCapacityClass.id, 1)).toBe(true); // this is the finding-1 fix, proven directly

    await db.insert(corporateBookings).values({
      classId: sharedCapacityClass.id,
      userId: member3.id,
      companyId: fixtures.company.id,
      status: "booked",
      creditsUsed: 1,
    });

    expect(await confirmedCount(db, sharedCapacityClass.id)).toBe(2);
  });

  it("does not count waitlisted or cancelled rows", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1 } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    await db.insert(bookings).values([
      {
        classId: roomyClass.id,
        userId: member1.id,
        membershipId: fixtures.memberships.membership1.id,
        status: "waitlisted",
        creditsUsed: 0,
      },
    ]);

    expect(await confirmedCount(db, roomyClass.id)).toBe(0);
  });
});

describe("chargeCredits / refundCredits", () => {
  it("deducts from a limited membership and refunds correctly", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const source = { kind: "membership" as const, membershipId: fixtures.memberships.membership1.id };

    await chargeCredits(db, source, 2);
    let m = await db.select().from(memberships).where(eq(memberships.id, source.membershipId)).get();
    expect(m?.creditsRemaining).toBe(3); // 5 - 2

    await refundCredits(db, source, 2);
    m = await db.select().from(memberships).where(eq(memberships.id, source.membershipId)).get();
    expect(m?.creditsRemaining).toBe(5);
  });

  it("skips deduction entirely for an unlimited membership", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const source = { kind: "membership" as const, membershipId: fixtures.memberships.membership2.id }; // unlimited

    await chargeCredits(db, source, 3);
    const m = await db.select().from(memberships).where(eq(memberships.id, source.membershipId)).get();
    expect(m?.creditsRemaining).toBe(UNLIMITED_CREDITS); // untouched
  });

  it("floors at 0 rather than going negative when charging more than available", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const source = { kind: "membership" as const, membershipId: fixtures.memberships.membership1.id }; // 5 credits

    await chargeCredits(db, source, 999);
    const m = await db.select().from(memberships).where(eq(memberships.id, source.membershipId)).get();
    expect(m?.creditsRemaining).toBe(0); // not -994
  });

  it("deducts from and refunds a company credit pool (no unlimited concept)", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const source = { kind: "company" as const, companyId: fixtures.company.id }; // starts at 10

    await chargeCredits(db, source, 4);
    let c = await db.select().from(companies).where(eq(companies.id, source.companyId)).get();
    expect(c?.creditPoolBalance).toBe(6);

    await refundCredits(db, source, 4);
    c = await db.select().from(companies).where(eq(companies.id, source.companyId)).get();
    expect(c?.creditPoolBalance).toBe(10);
  });

  it("floors a company pool at 0 too — resolves finding 15's inconsistency by applying the same policy to both source types", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const source = { kind: "company" as const, companyId: fixtures.company.id }; // starts at 10

    await chargeCredits(db, source, 999);
    const c = await db.select().from(companies).where(eq(companies.id, source.companyId)).get();
    expect(c?.creditPoolBalance).toBe(0);
  });
});

describe("cancelClassBookings", () => {
  it("refunds and cancels booked personal bookings", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1 } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    const [booking] = await db
      .insert(bookings)
      .values({
        classId: roomyClass.id,
        userId: member1.id,
        membershipId: fixtures.memberships.membership1.id,
        status: "booked",
        creditsUsed: 1,
      })
      .returning();

    await db.update(memberships).set({ creditsRemaining: 4 }).where(eq(memberships.id, fixtures.memberships.membership1.id)); // simulate having already spent it

    const result = await cancelClassBookings(db, { id: roomyClass.id, creditCost: 1 });
    expect(result.refundedPersonal).toBe(1);

    const updated = await db.select().from(bookings).where(eq(bookings.id, booking.id)).get();
    expect(updated?.status).toBe("cancelled");

    const m = await db.select().from(memberships).where(eq(memberships.id, fixtures.memberships.membership1.id)).get();
    expect(m?.creditsRemaining).toBe(5); // refunded, no time-window check
  });

  it("refunds and cancels booked corporate bookings", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member3 } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    await db.insert(corporateBookings).values({
      classId: roomyClass.id,
      userId: member3.id,
      companyId: fixtures.company.id,
      status: "booked",
      creditsUsed: 1,
    });
    await db.update(companies).set({ creditPoolBalance: 9 }).where(eq(companies.id, fixtures.company.id));

    const result = await cancelClassBookings(db, { id: roomyClass.id, creditCost: 1 });
    expect(result.refundedCorporate).toBe(1);

    const c = await db.select().from(companies).where(eq(companies.id, fixtures.company.id)).get();
    expect(c?.creditPoolBalance).toBe(10); // refunded
  });

  it("cancels waitlisted rows (both personal and corporate) without refunding, since they were never charged", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1, member3 } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    const [personalWaitlisted] = await db
      .insert(bookings)
      .values({
        classId: roomyClass.id,
        userId: member1.id,
        membershipId: fixtures.memberships.membership1.id,
        status: "waitlisted",
        creditsUsed: 0,
      })
      .returning();

    const [corporateWaitlisted] = await db
      .insert(corporateBookings)
      .values({
        classId: roomyClass.id,
        userId: member3.id,
        companyId: fixtures.company.id,
        status: "waitlisted",
        creditsUsed: 0,
      })
      .returning();

    const result = await cancelClassBookings(db, { id: roomyClass.id, creditCost: 1 });
    expect(result.waitlistedCleared).toBe(2);

    const p = await db.select().from(bookings).where(eq(bookings.id, personalWaitlisted.id)).get();
    expect(p?.status).toBe("cancelled"); // no longer orphaned

    const c = await db.select().from(corporateBookings).where(eq(corporateBookings.id, corporateWaitlisted.id)).get();
    expect(c?.status).toBe("cancelled");
  });
});

describe("promoteNextWaitlisted", () => {
  it("returns null when nobody is waiting", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const result = await promoteNextWaitlisted(db, {
      id: fixtures.classes.roomyClass.id,
      creditCost: 1,
    });
    expect(result).toBeNull();
  });

  it("promotes a personal waitlisted booking and charges the membership", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1 } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    const [waitlisted] = await db
      .insert(bookings)
      .values({
        classId: roomyClass.id,
        userId: member1.id,
        membershipId: fixtures.memberships.membership1.id,
        status: "waitlisted",
        creditsUsed: 0,
      })
      .returning();

    const result = await promoteNextWaitlisted(db, { id: roomyClass.id, creditCost: 1 });
    expect(result).toEqual({ kind: "personal", bookingId: waitlisted.id });

    const updated = await db.select().from(bookings).where(eq(bookings.id, waitlisted.id)).get();
    expect(updated?.status).toBe("booked");
    expect(updated?.creditsUsed).toBe(1);

    const m = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, fixtures.memberships.membership1.id))
      .get();
    expect(m?.creditsRemaining).toBe(4); // 5 - 1
  });

  it("promotes a corporate waitlisted booking and charges the company pool", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member3 } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    const [waitlisted] = await db
      .insert(corporateBookings)
      .values({
        classId: roomyClass.id,
        userId: member3.id,
        companyId: fixtures.company.id,
        status: "waitlisted",
        creditsUsed: 0,
      })
      .returning();

    const result = await promoteNextWaitlisted(db, { id: roomyClass.id, creditCost: 1 });
    expect(result).toEqual({ kind: "corporate", bookingId: waitlisted.id });

    const updated = await db
      .select()
      .from(corporateBookings)
      .where(eq(corporateBookings.id, waitlisted.id))
      .get();
    expect(updated?.status).toBe("booked");

    const c = await db.select().from(companies).where(eq(companies.id, fixtures.company.id)).get();
    expect(c?.creditPoolBalance).toBe(9); // 10 - 1
  });

  it("promotes whichever of personal/corporate has waited longest, across both tables", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1, member3 } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    // Corporate booking inserted first (waited longer)...
    const [corporateWaitlisted] = await db
      .insert(corporateBookings)
      .values({
        classId: roomyClass.id,
        userId: member3.id,
        companyId: fixtures.company.id,
        status: "waitlisted",
        creditsUsed: 0,
        bookedAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
      })
      .returning();

    // ...personal booking inserted second (waited less).
    await db.insert(bookings).values({
      classId: roomyClass.id,
      userId: member1.id,
      membershipId: fixtures.memberships.membership1.id,
      status: "waitlisted",
      creditsUsed: 0,
      bookedAt: new Date().toISOString(),
    });

    const result = await promoteNextWaitlisted(db, { id: roomyClass.id, creditCost: 1 });
    // The corporate one waited longer, so it should win despite being in
    // a different table — this is the actual fix for finding 5/1: a
    // single, unified waitlist ordering across both booking types.
    expect(result).toEqual({ kind: "corporate", bookingId: corporateWaitlisted.id });
  });

  it("promotes even when the balance is insufficient, flooring at 0 (unifies finding 15)", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member3 } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    // Drain the company pool to below the class's credit cost first.
    await db.update(companies).set({ creditPoolBalance: 0 }).where(eq(companies.id, fixtures.company.id));

    const [waitlisted] = await db
      .insert(corporateBookings)
      .values({
        classId: roomyClass.id,
        userId: member3.id,
        companyId: fixtures.company.id,
        status: "waitlisted",
        creditsUsed: 0,
      })
      .returning();

    const result = await promoteNextWaitlisted(db, { id: roomyClass.id, creditCost: 1 });
    // Unlike the OLD corporate-bookings.ts behavior (which would silently
    // skip promotion's charge if balance was insufficient, see finding
    // 15), the unified policy still promotes — the member gets their
    // spot regardless, matching how personal bookings always worked.
    expect(result).toEqual({ kind: "corporate", bookingId: waitlisted.id });

    const updated = await db
      .select()
      .from(corporateBookings)
      .where(eq(corporateBookings.id, waitlisted.id))
      .get();
    expect(updated?.status).toBe("booked");

    const c = await db.select().from(companies).where(eq(companies.id, fixtures.company.id)).get();
    expect(c?.creditPoolBalance).toBe(0); // floored, not negative
  });
});
