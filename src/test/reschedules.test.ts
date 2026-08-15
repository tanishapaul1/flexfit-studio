import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resetDb, seedMinimal, callerAs } from "./helpers";

describe("reschedules.reschedule", () => {
  let fixtures: Awaited<ReturnType<typeof seedMinimal>>;

  beforeEach(async () => {
    await resetDb();
    fixtures = await seedMinimal();
  });

  it("moves the booking to the new class without re-charging credits", async () => {
    const { member1 } = fixtures.users;
    const { smallClass, yogaAlt } = fixtures.classes; // both named "Yoga"
    const caller = callerAs(member1);

    const original = await caller.bookings.book({ classId: smallClass.id });
    const result = await caller.reschedules.reschedule({
      fromBookingId: original.id,
      toClassId: yogaAlt.id,
    });

    expect(result.newStatus).toBe("booked");
    expect(result.newBooking.classId).toBe(yogaAlt.id);
    expect(result.newBooking.creditsUsed).toBe(1); // carried over, not re-charged

    const membership = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member1.id))
      .get();
    expect(membership?.creditsRemaining).toBe(4); // only charged once, at original booking
  });

  it("rejects rescheduling to a class with a different name", async () => {
    const { member1 } = fixtures.users;
    const { smallClass, roomyClass } = fixtures.classes; // "Yoga" vs "Spin"
    const caller = callerAs(member1);

    const original = await caller.bookings.book({ classId: smallClass.id });

    await expect(
      caller.reschedules.reschedule({
        fromBookingId: original.id,
        toClassId: roomyClass.id,
      }),
    ).rejects.toThrow("same name");
  });

  it("rejects rescheduling within 4 hours of the original class start", async () => {
    const { member1 } = fixtures.users;
    const { yogaStartingSoon, yogaAlt } = fixtures.classes; // starts in 2h
    const caller = callerAs(member1);

    const original = await caller.bookings.book({ classId: yogaStartingSoon.id });

    await expect(
      caller.reschedules.reschedule({
        fromBookingId: original.id,
        toClassId: yogaAlt.id,
      }),
    ).rejects.toThrow(`${4} hours before`);
  });

  it("lands as waitlisted when the target class is already full", async () => {
    const { member1, member2 } = fixtures.users;
    const { smallClass, yogaAltFull } = fixtures.classes;

    // member2 fills the target class first (capacity 1).
    await callerAs(member2).bookings.book({ classId: yogaAltFull.id });

    const original = await callerAs(member1).bookings.book({ classId: smallClass.id });
    const result = await callerAs(member1).reschedules.reschedule({
      fromBookingId: original.id,
      toClassId: yogaAltFull.id,
    });

    expect(result.newStatus).toBe("waitlisted");
  });
});

describe("Finding 5 (FIXED): rescheduling away from a class now promotes the waitlist", () => {
  let fixtures: Awaited<ReturnType<typeof seedMinimal>>;

  beforeEach(async () => {
    await resetDb();
    fixtures = await seedMinimal();
  });

  it("promotes the waitlisted member once the booked spot is freed via reschedule", async () => {
    const { member1, member2 } = fixtures.users;
    const { smallClass, yogaAlt } = fixtures.classes; // smallClass capacity 1, same name "Yoga"

    const firstBooking = await callerAs(member1).bookings.book({ classId: smallClass.id });
    const secondBooking = await callerAs(member2).bookings.book({ classId: smallClass.id });
    expect(secondBooking.status).toBe("waitlisted");

    // member1 reschedules away, freeing their confirmed spot on smallClass.
    await callerAs(member1).reschedules.reschedule({
      fromBookingId: firstBooking.id,
      toClassId: yogaAlt.id,
    });

    // Before the fix, member2 would stay "waitlisted" forever, since
    // reschedule() cancelled the original booking by direct status
    // update, bypassing bookings.cancel()'s promotion logic entirely.
    // Now reschedule() calls the same shared promoteNextWaitlisted()
    // that cancel() uses, so the outcome is consistent regardless of
    // *why* the spot was freed — see behavior-inventory.md finding 5.
    const afterReschedule = await callerAs(member2).bookings.mine({ includePast: false });
    const theBooking = afterReschedule.find((b) => b.id === secondBooking.id);
    expect(theBooking?.status).toBe("booked"); // now promoted
  });
});
