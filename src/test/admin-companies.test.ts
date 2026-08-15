import { describe, it, expect } from "vitest";
import { resetDb, seedMinimal, callerAs } from "./helpers";

describe("adminCompanies — all endpoints are admin-only", () => {
  it("rejects non-admin callers across the router", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { trainer } = fixtures.users;

    await expect(callerAs(trainer).adminCompanies.list()).rejects.toThrow();
    await expect(
      callerAs(trainer).adminCompanies.create({ name: "X", contactEmail: "x@x.com" }),
    ).rejects.toThrow();
  });
});

describe("adminCompanies.topUp", () => {
  it("adds to the existing balance rather than replacing it", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { admin } = fixtures.users;

    const result = await callerAs(admin).adminCompanies.topUp({
      id: fixtures.company.id,
      amount: 5,
    });
    expect(result.creditPoolBalance).toBe(15); // started at 10
  });
});

describe("adminCompanies.linkMember", () => {
  it("only allows role='member' users to be linked", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { admin, trainer } = fixtures.users;

    await expect(
      callerAs(admin).adminCompanies.linkMember({
        companyId: fixtures.company.id,
        userId: trainer.id,
      }),
    ).rejects.toThrow("Only members");
  });

  it("rejects linking the same member to the same company twice", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { admin } = fixtures.users;
    const { member3 } = fixtures.users; // already linked to fixtures.company in seedMinimal

    await expect(
      callerAs(admin).adminCompanies.linkMember({
        companyId: fixtures.company.id,
        userId: member3.id,
      }),
    ).rejects.toThrow("already linked");
  });

  it("getById returns members and recent corporate bookings for the company", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { admin, member3 } = fixtures.users;

    await callerAs(member3).corporateBookings.book({ classId: fixtures.classes.roomyClass.id });

    const detail = await callerAs(admin).adminCompanies.getById({ id: fixtures.company.id });
    expect(detail.members).toHaveLength(1);
    expect(detail.members[0].id).toBe(member3.id);
    expect(detail.recentBookings).toHaveLength(1);
  });
});
