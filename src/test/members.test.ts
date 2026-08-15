import { describe, it, expect } from "vitest";
import { resetDb, seedMinimal, callerAs } from "./helpers";

describe("members.profile", () => {
  it("returns own profile with membership details, or null membership if none", async () => {
    await resetDb();
    const fixtures = await seedMinimal();

    const withMembership = await callerAs(fixtures.users.member1).members.profile();
    expect(withMembership.membership?.planName).toBe("Basic");
    expect(withMembership.classesAttended).toBe(0);

    const withoutMembership = await callerAs(fixtures.users.member3).members.profile();
    expect(withoutMembership.membership).toBeNull();
  });
});

describe("members.updateProfile", () => {
  it("updates only the calling user's own name/phone", async () => {
    await resetDb();
    const fixtures = await seedMinimal();

    const updated = await callerAs(fixtures.users.member1).members.updateProfile({
      name: "Updated Name",
      phone: "555-0100",
    });
    expect(updated.name).toBe("Updated Name");
    expect(updated.phone).toBe("555-0100");
  });
});

describe("members.search / byId — passwordHash is never exposed", () => {
  it("search results never include passwordHash (selected columns only)", async () => {
    await resetDb();
    const fixtures = await seedMinimal();

    const results = await callerAs(fixtures.users.admin).members.search({ q: "Member" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r).not.toHaveProperty("passwordHash");
    }
  });

  it("byId explicitly strips passwordHash before returning", async () => {
    await resetDb();
    const fixtures = await seedMinimal();

    const result = await callerAs(fixtures.users.admin).members.byId({
      id: fixtures.users.member1.id,
    });
    expect(result).not.toHaveProperty("passwordHash");
    expect(result.memberships).toBeDefined();
  });

  it("search/byId are staff-only, rejecting members", async () => {
    await resetDb();
    const fixtures = await seedMinimal();

    await expect(
      callerAs(fixtures.users.member1).members.search({ q: "" }),
    ).rejects.toThrow();
    await expect(
      callerAs(fixtures.users.member1).members.byId({ id: fixtures.users.member2.id }),
    ).rejects.toThrow();
  });
});

describe("members.setActive / setRole — admin only", () => {
  it("rejects staff (trainer) from changing active status or role, only admin can", async () => {
    await resetDb();
    const fixtures = await seedMinimal();

    await expect(
      callerAs(fixtures.users.trainer).members.setActive({
        id: fixtures.users.member1.id,
        active: false,
      }),
    ).rejects.toThrow();

    const updated = await callerAs(fixtures.users.admin).members.setActive({
      id: fixtures.users.member1.id,
      active: false,
    });
    expect(updated.active).toBe(false);
  });
});

describe("members.lookupByEmailOrPhone", () => {
  it("only finds users with role='member', 404s for a trainer's email", async () => {
    await resetDb();
    const fixtures = await seedMinimal();

    const found = await callerAs(fixtures.users.admin).members.lookupByEmailOrPhone({
      query: "member1@test.local",
    });
    expect(found.id).toBe(fixtures.users.member1.id);

    await expect(
      callerAs(fixtures.users.admin).members.lookupByEmailOrPhone({
        query: "trainer@test.local",
      }),
    ).rejects.toThrow("not found");
  });
});
