import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { payments, memberships } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resetDb, seedMinimal, callerAs } from "./helpers";

describe("payments.mine / payments.all", () => {
  it("mine returns only the caller's own payments with the plan name joined in", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1, member2 } = fixtures.users;

    await callerAs(member1).plans.subscribe({ planId: fixtures.plans.limitedPlan.id });

    const mine = await callerAs(member1).payments.mine();
    expect(mine).toHaveLength(1);
    expect(mine[0].planName).toBe("Basic");

    const other = await callerAs(member2).payments.mine();
    expect(other).toHaveLength(0);
  });

  it("all is admin-only and includes member identity", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1, admin } = fixtures.users;

    await callerAs(member1).plans.subscribe({ planId: fixtures.plans.limitedPlan.id });

    await expect(callerAs(member1).payments.all()).rejects.toThrow();

    const all = await callerAs(admin).payments.all();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all[0].memberEmail).toBeDefined();
  });
});

describe("payments.refund", () => {
  it("cancels the associated membership but does NOT reverse spent credits", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member3, admin } = fixtures.users; // no pre-existing membership, unlike member1
    const { roomyClass } = fixtures.classes;

    const membership = await callerAs(member3).plans.subscribe({
      planId: fixtures.plans.limitedPlan.id,
    });
    await callerAs(member3).bookings.book({ classId: roomyClass.id });

    const payment = await db
      .select()
      .from(payments)
      .where(eq(payments.membershipId, membership.id))
      .get();

    await callerAs(admin).payments.refund({ id: payment!.id });

    const refundedPayment = await db.select().from(payments).where(eq(payments.id, payment!.id)).get();
    expect(refundedPayment?.status).toBe("refunded");

    const cancelledMembership = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, membership.id))
      .get();
    expect(cancelledMembership?.status).toBe("cancelled");
    // Credit was spent booking roomyClass (5 -> 4); refund does not
    // restore it, even though the membership itself is now cancelled.
    expect(cancelledMembership?.creditsRemaining).toBe(4);
  });

  it("rejects refunding a payment that isn't currently 'paid' (no double refunds)", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1, admin } = fixtures.users;

    const membership = await callerAs(member1).plans.subscribe({
      planId: fixtures.plans.limitedPlan.id,
    });
    const payment = await db
      .select()
      .from(payments)
      .where(eq(payments.membershipId, membership.id))
      .get();

    await callerAs(admin).payments.refund({ id: payment!.id });

    await expect(callerAs(admin).payments.refund({ id: payment!.id })).rejects.toThrow(
      "Only paid payments",
    );
  });
});

describe("payments.markPaid", () => {
  it("rejects marking a refunded payment as paid again", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1, admin } = fixtures.users;

    const membership = await callerAs(member1).plans.subscribe({
      planId: fixtures.plans.limitedPlan.id,
    });
    const payment = await db
      .select()
      .from(payments)
      .where(eq(payments.membershipId, membership.id))
      .get();

    await callerAs(admin).payments.refund({ id: payment!.id });

    await expect(callerAs(admin).payments.markPaid({ id: payment!.id })).rejects.toThrow(
      "cannot be marked paid",
    );
  });
});
