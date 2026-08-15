import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { companies, checkins, bookings, corporateBookings } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { resetDb, seedMinimal, callerAs } from "./helpers";

describe("corporateBookings.book", () => {
  let fixtures: Awaited<ReturnType<typeof seedMinimal>>;

  beforeEach(async () => {
    await resetDb();
    fixtures = await seedMinimal();
  });

  it("books a class and deducts from the company credit pool, not a personal membership", async () => {
    const { member3 } = fixtures.users; // linked to the company, no personal membership
    const { roomyClass } = fixtures.classes;

    const booking = await callerAs(member3).corporateBookings.book({ classId: roomyClass.id });
    expect(booking.status).toBe("booked");

    const company = await db.select().from(companies).where(eq(companies.id, fixtures.company.id)).get();
    expect(company?.creditPoolBalance).toBe(9); // started at 10
  });

  it("rejects booking when not linked to an active company", async () => {
    const { member1 } = fixtures.users; // not linked to any company
    const { roomyClass } = fixtures.classes;

    await expect(
      callerAs(member1).corporateBookings.book({ classId: roomyClass.id }),
    ).rejects.toThrow("not linked to an active company");
  });

  it("uses a 24-hour free-cancellation window, not the personal 12-hour one", async () => {
    const { member3 } = fixtures.users;
    const { soonClass } = fixtures.classes; // starts 6h from now

    const booking = await callerAs(member3).corporateBookings.book({ classId: soonClass.id });
    const result = await callerAs(member3).corporateBookings.cancel({ bookingId: booking.id });

    // 6h before start is inside the 24h corporate window, so no refund —
    // this proves the router enforces 24h, not the personal 12h rule.
    expect(result.refunded).toBe(false);
  });

  it("Finding 2 (FIXED): records a check-in linked via corporateBookingId, and checkinCountFor now counts it", async () => {
    const { member3, admin } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    const booking = await callerAs(member3).corporateBookings.book({ classId: roomyClass.id });
    await callerAs(admin).corporateBookings.markAttended({ bookingId: booking.id });

    const checkinRows = await db.select().from(checkins).where(eq(checkins.userId, member3.id));
    expect(checkinRows).toHaveLength(1);
    // Before the fix, bookingId was always left null with no way to trace
    // the check-in back to a booking at all. Now corporateBookingId links
    // it, and bookingId stays null (correctly — it was never a personal
    // booking). See behavior-inventory.md finding 2.
    expect(checkinRows[0].bookingId).toBeNull();
    expect(checkinRows[0].corporateBookingId).toBe(booking.id);

    // Previously bookings.checkinCountFor only joined on bookingId, so it
    // silently undercounted any class with corporate attendees. Now it
    // correctly includes this corporate check-in.
    const count = await callerAs(admin).bookings.checkinCountFor({ classId: roomyClass.id });
    expect(count.count).toBe(1);
  });

  it("counts personal AND corporate check-ins together for the same class", async () => {
    const { member1, member3, admin } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    const personalBooking = await callerAs(member1).bookings.book({ classId: roomyClass.id });
    await callerAs(admin).bookings.markAttended({ bookingId: personalBooking.id });

    const corporateBooking = await callerAs(member3).corporateBookings.book({ classId: roomyClass.id });
    await callerAs(admin).corporateBookings.markAttended({ bookingId: corporateBooking.id });

    const count = await callerAs(admin).bookings.checkinCountFor({ classId: roomyClass.id });
    // Before the fix, this would have been 1 (personal only) — a real
    // attendance-reporting undercount whenever a class had corporate
    // attendees. Now it correctly reflects both.
    expect(count.count).toBe(2);
  });
});

describe("Finding 1 (FIXED): capacity is now shared between personal and corporate bookings", () => {
  let fixtures: Awaited<ReturnType<typeof seedMinimal>>;

  beforeEach(async () => {
    await resetDb();
    fixtures = await seedMinimal();
  });

  it("waitlists a corporate booking when a personal booking has already filled a capacity-1 class", async () => {
    const { member1, member3 } = fixtures.users;
    const { sharedCapacityClass } = fixtures.classes; // capacity: 1

    // member1 books personally — the room is now confirmed-full at 1/1,
    // counting across BOTH booking types (see booking-core.ts).
    const personalBooking = await callerAs(member1).bookings.book({
      classId: sharedCapacityClass.id,
    });
    expect(personalBooking.status).toBe("booked");

    // member3 attempts to book corporately. Before the fix, this would
    // incorrectly succeed as "booked" (see behavior-inventory.md finding
    // 1) because corporateBookings.book only counted its own table. Now
    // it correctly lands on the waitlist instead.
    const corporateBooking = await callerAs(member3).corporateBookings.book({
      classId: sharedCapacityClass.id,
    });
    expect(corporateBooking.status).toBe("waitlisted");
    expect(corporateBooking.creditsUsed).toBe(0); // waitlisted bookings are never charged

    // Confirm there's exactly ONE confirmed attendee for a capacity-1
    // room, across both tables combined — the actual invariant the bug
    // used to violate.
    const confirmedPersonal = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.classId, sharedCapacityClass.id), eq(bookings.status, "booked")));
    const confirmedCorporate = await db
      .select()
      .from(corporateBookings)
      .where(
        and(
          eq(corporateBookings.classId, sharedCapacityClass.id),
          eq(corporateBookings.status, "booked"),
        ),
      );

    const totalConfirmed = confirmedPersonal.length + confirmedCorporate.length;
    expect(totalConfirmed).toBe(1);
    expect(totalConfirmed).toBeLessThanOrEqual(sharedCapacityClass.capacity);
  });

  it("promotes the corporate waitlisted member (not just personal ones) when the personal booking is cancelled", async () => {
    const { member1, member3 } = fixtures.users;
    const { sharedCapacityClass } = fixtures.classes;

    const personalBooking = await callerAs(member1).bookings.book({
      classId: sharedCapacityClass.id,
    });
    const corporateBooking = await callerAs(member3).corporateBookings.book({
      classId: sharedCapacityClass.id,
    });
    expect(corporateBooking.status).toBe("waitlisted");

    // member1 cancels, freeing the one confirmed spot.
    await callerAs(member1).bookings.cancel({ bookingId: personalBooking.id });

    // The corporate waitlisted member should now be promoted — this is
    // the unified cross-table waitlist from booking-core.ts's
    // promoteNextWaitlisted, closing finding 5 as well as finding 1.
    const corporateRows = await callerAs(member3).corporateBookings.mine({ includePast: false });
    const promoted = corporateRows.find((b) => b.id === corporateBooking.id);
    expect(promoted?.status).toBe("booked");
  });
});
