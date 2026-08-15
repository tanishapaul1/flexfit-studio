import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resetDb, seedMinimal, callerAs } from "./helpers";

describe("bookings.book", () => {
  let fixtures: Awaited<ReturnType<typeof seedMinimal>>;

  beforeEach(async () => {
    await resetDb();
    fixtures = await seedMinimal();
  });

  it("books a class and deducts one credit for a limited-credit member", async () => {
    const { member1 } = fixtures.users;
    const { roomyClass } = fixtures.classes;
    const caller = callerAs(member1);

    const booking = await caller.bookings.book({ classId: roomyClass.id });

    expect(booking.status).toBe("booked");
    expect(booking.creditsUsed).toBe(1);

    const membership = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member1.id))
      .get();
    expect(membership?.creditsRemaining).toBe(4); // started at 5
  });

  it("does not deduct credits for an unlimited-plan member", async () => {
    const { member2 } = fixtures.users;
    const { roomyClass } = fixtures.classes;
    const caller = callerAs(member2);

    await caller.bookings.book({ classId: roomyClass.id });

    const membership = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member2.id))
      .get();
    expect(membership?.creditsRemaining).toBe(999); // unchanged
  });

  it("rejects booking without an active membership", async () => {
    const { member3 } = fixtures.users; // no membership seeded
    const { roomyClass } = fixtures.classes;
    const caller = callerAs(member3);

    await expect(
      caller.bookings.book({ classId: roomyClass.id }),
    ).rejects.toThrow("An active membership is required");
  });

  it("waitlists the second booker on a full class, charging no credits", async () => {
    const { member1, member2 } = fixtures.users;
    const { smallClass } = fixtures.classes; // capacity 1

    const first = await callerAs(member1).bookings.book({ classId: smallClass.id });
    expect(first.status).toBe("booked");

    const second = await callerAs(member2).bookings.book({ classId: smallClass.id });
    expect(second.status).toBe("waitlisted");
    expect(second.creditsUsed).toBe(0);

    // member2 is on an unlimited plan, but this documents that waitlisted
    // bookings never charge credits regardless of plan type.
    const m2 = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member2.id))
      .get();
    expect(m2?.creditsRemaining).toBe(999);
  });

  it("rejects a duplicate booking for a class the member is already on", async () => {
    const { member1 } = fixtures.users;
    const { roomyClass } = fixtures.classes;
    const caller = callerAs(member1);

    await caller.bookings.book({ classId: roomyClass.id });

    await expect(
      caller.bookings.book({ classId: roomyClass.id }),
    ).rejects.toThrow("already on the list");
  });

  it("rejects booking with insufficient credits", async () => {
    const { member1 } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    // Drain member1's credits to 0 first.
    await db
      .update(memberships)
      .set({ creditsRemaining: 0 })
      .where(eq(memberships.userId, member1.id));

    await expect(
      callerAs(member1).bookings.book({ classId: roomyClass.id }),
    ).rejects.toThrow("Not enough class credits");
  });
});

describe("bookings.cancel", () => {
  let fixtures: Awaited<ReturnType<typeof seedMinimal>>;

  beforeEach(async () => {
    await resetDb();
    fixtures = await seedMinimal();
  });

  it("refunds the credit when cancelling 12+ hours before class start", async () => {
    const { member1 } = fixtures.users;
    const { roomyClass } = fixtures.classes; // starts 48h from now
    const caller = callerAs(member1);

    const booking = await caller.bookings.book({ classId: roomyClass.id });
    const result = await caller.bookings.cancel({ bookingId: booking.id });

    expect(result.refunded).toBe(true);

    const membership = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member1.id))
      .get();
    expect(membership?.creditsRemaining).toBe(5); // back to starting amount
  });

  it("does NOT refund the credit when cancelling inside the 12-hour window", async () => {
    const { member1 } = fixtures.users;
    const { soonClass } = fixtures.classes; // starts 6h from now
    const caller = callerAs(member1);

    const booking = await caller.bookings.book({ classId: soonClass.id });
    const result = await caller.bookings.cancel({ bookingId: booking.id });

    expect(result.refunded).toBe(false);

    const membership = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member1.id))
      .get();
    expect(membership?.creditsRemaining).toBe(4); // credit stays spent
  });

  it("promotes the longest-waiting waitlisted member when a booked spot is cancelled", async () => {
    const { member1, member2 } = fixtures.users;
    const { smallClass } = fixtures.classes; // capacity 1

    const firstBooking = await callerAs(member1).bookings.book({ classId: smallClass.id });
    const secondBooking = await callerAs(member2).bookings.book({ classId: smallClass.id });
    expect(secondBooking.status).toBe("waitlisted");

    await callerAs(member1).bookings.cancel({ bookingId: firstBooking.id });

    const promoted = await callerAs(member2).bookings.mine({ includePast: false });
    const theBooking = promoted.find((b) => b.id === secondBooking.id);
    expect(theBooking?.status).toBe("booked");

    // member2 is on the unlimited plan (999 credits = UNLIMITED_CREDITS),
    // so the unlimited guard applies at promotion time too — balance is
    // untouched even though `creditsUsed` gets set on the booking itself.
    const m2 = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member2.id))
      .get();
    expect(m2?.creditsRemaining).toBe(999);
  });

  it("deducts credits at promotion time for a limited-plan member", async () => {
    // Reproduces the same scenario with a limited-credit member instead,
    // to actually exercise the deduction branch (member2/unlimited above
    // exercises the guard that skips it).
    const { member1, member2 } = fixtures.users;
    const { smallClass } = fixtures.classes; // capacity 1

    // member1 books first, then cancels their own spot; we need a third
    // limited-credit member to be the one waitlisted and promoted, so
    // give member2 a limited membership for this test instead of relying
    // on the unlimited one from seedMinimal.
    await db
      .update(memberships)
      .set({ creditsRemaining: 3 })
      .where(eq(memberships.userId, member2.id));

    const firstBooking = await callerAs(member1).bookings.book({ classId: smallClass.id });
    await callerAs(member2).bookings.book({ classId: smallClass.id }); // waitlisted

    await callerAs(member1).bookings.cancel({ bookingId: firstBooking.id });

    const m2 = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member2.id))
      .get();
    expect(m2?.creditsRemaining).toBe(2); // 3 - 1, actually deducted
  });

  it("only the owner or staff can cancel a booking", async () => {
    const { member1, member2 } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    const booking = await callerAs(member1).bookings.book({ classId: roomyClass.id });

    await expect(
      callerAs(member2).bookings.cancel({ bookingId: booking.id }),
    ).rejects.toThrow("You cannot cancel this booking");
  });
});
