import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resetDb, seedMinimal, callerAs, daysFromToday } from "./helpers";

describe("admin.stats", () => {
  it("computes totalMembers, activeMemberships, and revenueCents correctly", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { admin, member3 } = fixtures.users;

    await callerAs(member3).plans.subscribe({ planId: fixtures.plans.limitedPlan.id }); // adds revenue + a membership

    const stats = await callerAs(admin).admin.stats();
    expect(stats.totalMembers).toBe(3); // member1, member2, member3
    expect(stats.activeMemberships).toBe(3); // membership1, membership2, + member3's new one
    expect(stats.revenueCents).toBe(5000); // Basic plan price
  });

  it("is admin-only", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    await expect(callerAs(fixtures.users.trainer).admin.stats()).rejects.toThrow();
  });
});

describe("admin.classUtilisation", () => {
  it("Finding 14 (FIXED): correctly reports booked count and utilisation now that the column-qualification bug is fixed", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1 } = fixtures.users;
    const { smallClass } = fixtures.classes; // capacity 1

    await callerAs(member1).bookings.book({ classId: smallClass.id });

    const rows = await callerAs(fixtures.users.admin).admin.classUtilisation();
    const row = rows.find((r) => r.id === smallClass.id);

    // Fixed by adding a leftJoin, which forces Drizzle to fully qualify
    // the correlated subquery's column references — see the comment in
    // admin.ts and behavior-inventory.md finding 14 for the root-cause
    // explanation. Before the fix, this was always 0 regardless of real
    // bookings.
    expect(row?.booked).toBe(1);
    expect(row?.utilisation).toBe(1); // 1/1 capacity
  });
});

describe("admin.expiringMemberships", () => {
  it("includes memberships expiring within 14 days, excludes ones further out", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { admin, member1, member3 } = fixtures.users;

    // member1's seeded membership expires in 30 days — should NOT appear.
    // Give member3 a membership expiring in 5 days — SHOULD appear.
    await callerAs(member3).plans.subscribe({ planId: fixtures.plans.limitedPlan.id });
    const m3 = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member3.id))
      .get();
    await db
      .update(memberships)
      .set({ endDate: daysFromToday(5) })
      .where(eq(memberships.id, m3!.id));

    const expiring = await callerAs(admin).admin.expiringMemberships();
    expect(expiring.some((e) => e.memberId === member3.id)).toBe(true);
    expect(expiring.some((e) => e.memberId === member1.id)).toBe(false);
  });
});

describe("admin.refundCount", () => {
  it("counts refunded payments", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { admin, member3 } = fixtures.users;
    const { payments } = await import("@/db/schema");

    const membership = await callerAs(member3).plans.subscribe({
      planId: fixtures.plans.limitedPlan.id,
    });
    const paymentRow = await db
      .select()
      .from(payments)
      .where(eq(payments.membershipId, membership.id))
      .get();

    await callerAs(admin).payments.refund({ id: paymentRow!.id });

    const result = await callerAs(admin).admin.refundCount();
    expect(result.count).toBe(1);
  });
});

describe("Finding 13 (new): no_show is read by admin.noShowList but never set by any mutation", () => {
  it("noShowList is always empty for real (non-seeded) data, since nothing ever transitions a booking to no_show", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1, admin } = fixtures.users;
    const { roomyClass } = fixtures.classes;

    // Book a class, and let it "pass" without the member attending —
    // in the real app, there is no automatic or manual mechanism (no
    // cron job, no admin mutation) that ever sets status to 'no_show'.
    // markAttended only transitions booked -> attended; nothing handles
    // the case of a booking nobody acted on.
    await callerAs(member1).bookings.book({ classId: roomyClass.id });

    const noShows = await callerAs(admin).admin.noShowList();
    expect(noShows).toHaveLength(0); // always, regardless of what actually happened
  });
});
