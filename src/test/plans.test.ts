import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { membershipPlans, memberships, payments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resetDb, seedMinimal, callerAs } from "./helpers";

describe("plans.list", () => {
  it("excludes inactive plans by default, includes them when asked", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    await db
      .update(membershipPlans)
      .set({ active: false })
      .where(eq(membershipPlans.id, fixtures.plans.limitedPlan.id));

    const activeOnly = await callerAs(null).plans.list();
    expect(activeOnly.find((p) => p.id === fixtures.plans.limitedPlan.id)).toBeUndefined();

    const all = await callerAs(null).plans.list({ includeInactive: true });
    expect(all.find((p) => p.id === fixtures.plans.limitedPlan.id)).toBeDefined();
  });
});

describe("plans.subscribe", () => {
  it("creates an active membership and an already-paid payment record", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member3 } = fixtures.users; // no membership yet

    const membership = await callerAs(member3).plans.subscribe({
      planId: fixtures.plans.limitedPlan.id,
      method: "upi",
    });

    expect(membership.status).toBe("active");
    expect(membership.creditsRemaining).toBe(5);

    const payment = await db
      .select()
      .from(payments)
      .where(eq(payments.membershipId, membership.id))
      .get();
    expect(payment?.status).toBe("paid"); // no pending step
    expect(payment?.method).toBe("upi");
  });

  it("rejects subscribing to an inactive plan", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    await db
      .update(membershipPlans)
      .set({ active: false })
      .where(eq(membershipPlans.id, fixtures.plans.limitedPlan.id));

    await expect(
      callerAs(fixtures.users.member3).plans.subscribe({ planId: fixtures.plans.limitedPlan.id }),
    ).rejects.toThrow("no longer available");
  });
});

describe("Finding 8: multiple simultaneous active memberships are possible", () => {
  it("allows subscribing to a second plan without touching the first, and activeMembershipFor picks the one with the furthest endDate", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1 } = fixtures.users; // already has an active limited membership (5 credits, from seedMinimal)

    // Give the unlimited plan a longer duration than the limited plan so
    // its computed endDate is unambiguously further out — both plans
    // default to 30 days in seedMinimal, which ties endDates and makes
    // "furthest endDate wins" untestable (SQLite doesn't guarantee tie
    // ordering; an earlier version of this test learned that the hard way).
    await db
      .update(membershipPlans)
      .set({ durationDays: 90 })
      .where(eq(membershipPlans.id, fixtures.plans.unlimitedPlan.id));

    const secondMembership = await callerAs(member1).plans.subscribe({
      planId: fixtures.plans.unlimitedPlan.id,
    });

    // Both memberships now exist for member1.
    const allMemberships = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member1.id));
    expect(allMemberships).toHaveLength(2);
    expect(allMemberships.every((m) => m.status === "active")).toBe(true);

    // Booking logic (activeMembershipFor) picks whichever has the
    // furthest endDate. The unlimited membership now clearly has the
    // later endDate (90 days out vs. 30), so it should be selected —
    // the original limited membership's 5 credits become unreachable,
    // not consolidated with the new one.
    const booking = await callerAs(member1).bookings.book({
      classId: fixtures.classes.roomyClass.id,
    });
    expect(booking.membershipId).toBe(secondMembership.id);
  });
});
