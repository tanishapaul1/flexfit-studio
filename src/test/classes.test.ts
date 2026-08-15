import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { memberships, bookings, companies, corporateBookings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resetDb, seedMinimal, callerAs } from "./helpers";

describe("classes.list", () => {
  let fixtures: Awaited<ReturnType<typeof seedMinimal>>;

  beforeEach(async () => {
    await resetDb();
    fixtures = await seedMinimal();
  });

  it("computes spotsLeft and full correctly, and excludes cancelled classes by default", async () => {
    const { member1 } = fixtures.users;
    const { smallClass } = fixtures.classes; // capacity 1

    const beforeBooking = await callerAs(null).classes.list();
    const small1 = beforeBooking.find((c) => c.id === smallClass.id);
    expect(small1?.spotsLeft).toBe(1);
    expect(small1?.full).toBe(false);

    await callerAs(member1).bookings.book({ classId: smallClass.id });

    const afterBooking = await callerAs(null).classes.list();
    const small2 = afterBooking.find((c) => c.id === smallClass.id);
    expect(small2?.spotsLeft).toBe(0);
    expect(small2?.full).toBe(true);

    await callerAs(fixtures.users.admin).classes.cancel({ id: smallClass.id });

    const afterCancel = await callerAs(null).classes.list();
    expect(afterCancel.find((c) => c.id === smallClass.id)).toBeUndefined();

    const withCancelled = await callerAs(null).classes.list({ includeCancelled: true });
    expect(withCancelled.find((c) => c.id === smallClass.id)).toBeDefined();
  });
});

describe("classes.create / update permissions", () => {
  let fixtures: Awaited<ReturnType<typeof seedMinimal>>;

  beforeEach(async () => {
    await resetDb();
    fixtures = await seedMinimal();
  });

  it("allows trainers and admins to create classes, rejects members", async () => {
    const { trainer, admin, member1 } = fixtures.users;
    const input = {
      name: "Zumba",
      room: "Studio Z",
      capacity: 5,
      startsAt: new Date().toISOString(),
    };

    await expect(callerAs(trainer).classes.create(input)).resolves.toBeDefined();
    await expect(callerAs(admin).classes.create(input)).resolves.toBeDefined();
    await expect(callerAs(member1).classes.create(input)).rejects.toThrow();
  });

  it("rejects trainers from cancelling classes (admin-only)", async () => {
    const { trainer } = fixtures.users;
    const { smallClass } = fixtures.classes;

    await expect(
      callerAs(trainer).classes.cancel({ id: smallClass.id }),
    ).rejects.toThrow();
  });
});

describe("Finding 4 (FIXED): classes.cancel now refunds credits and cleans up waitlisted rows", () => {
  let fixtures: Awaited<ReturnType<typeof seedMinimal>>;

  beforeEach(async () => {
    await resetDb();
    fixtures = await seedMinimal();
  });

  it("force-cancels booked bookings AND refunds credits, with no time-window check", async () => {
    const { member1, admin } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    await callerAs(member1).bookings.book({ classId: roomyClass.id });
    await callerAs(admin).classes.cancel({ id: roomyClass.id });

    const membership = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member1.id))
      .get();
    // Before the fix, a studio-initiated cancel never refunded credits at
    // all, unlike bookings.cancel. Now it does — no time-window check
    // applies here (unlike a member-initiated cancel's 12h rule), since
    // this wasn't the member's choice. See behavior-inventory.md finding 4.
    expect(membership?.creditsRemaining).toBe(5); // refunded

    const booking = await db
      .select()
      .from(bookings)
      .where(eq(bookings.userId, member1.id))
      .get();
    expect(booking?.status).toBe("cancelled");
  });

  it("cancels waitlisted bookings instead of leaving them orphaned", async () => {
    const { member1, member2, admin } = fixtures.users;
    const { smallClass } = fixtures.classes; // capacity 1

    await callerAs(member1).bookings.book({ classId: smallClass.id }); // booked
    const waitlisted = await callerAs(member2).bookings.book({ classId: smallClass.id }); // waitlisted
    expect(waitlisted.status).toBe("waitlisted");

    await callerAs(admin).classes.cancel({ id: smallClass.id });

    const stillThere = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, waitlisted.id))
      .get();
    // Before the fix, classes.cancel only touched status='booked' rows,
    // leaving waitlisted rows permanently "waitlisted" for a class that
    // no longer exists. Now they're correctly cancelled too.
    expect(stillThere?.status).toBe("cancelled");
  });

  it("also refunds and cancels corporate bookings for the class, not just personal ones", async () => {
    const { member3, admin } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    await callerAs(member3).corporateBookings.book({ classId: roomyClass.id });
    await callerAs(admin).classes.cancel({ id: roomyClass.id });

    const company = await db.select().from(companies).where(eq(companies.id, fixtures.company.id)).get();
    expect(company?.creditPoolBalance).toBe(10); // refunded

    const corpBooking = await db
      .select()
      .from(corporateBookings)
      .where(eq(corporateBookings.userId, member3.id))
      .get();
    expect(corpBooking?.status).toBe("cancelled");
  });
});
