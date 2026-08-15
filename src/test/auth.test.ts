import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "@/lib/password";
import { resetDb, seedMinimal, callerAs } from "./helpers";

describe("auth.me", () => {
  it("returns the current context user when authenticated, null otherwise", async () => {
    await resetDb();
    const fixtures = await seedMinimal();

    const me = await callerAs(fixtures.users.member1).auth.me();
    expect(me?.id).toBe(fixtures.users.member1.id);

    const anon = await callerAs(null).auth.me();
    expect(anon).toBeNull();
  });
});

describe("auth.register", () => {
  it("creates a user, always forcing role to 'member' regardless of who calls it", async () => {
    await resetDb();
    await seedMinimal();

    // Called anonymously (self-registration) — input schema has no `role`
    // field at all, so there is no way to request staff/admin via this
    // endpoint. Confirms the rule documented in behavior-inventory.md §3.
    const result = await callerAs(null).auth.register({
      email: "new.member@test.local",
      password: "hunter22",
      name: "New Member",
    });

    const created = await db.select().from(users).where(eq(users.id, result.id)).get();
    expect(created?.role).toBe("member");
  });

  it("rejects registration with an email that already exists", async () => {
    await resetDb();
    await seedMinimal();

    await expect(
      callerAs(null).auth.register({
        email: "member1@test.local", // already seeded
        password: "hunter22",
        name: "Duplicate",
      }),
    ).rejects.toThrow("already exists");
  });

  it("rejects passwords under 6 characters (zod input validation)", async () => {
    await resetDb();
    await seedMinimal();

    await expect(
      callerAs(null).auth.register({
        email: "short.pw@test.local",
        password: "abc",
        name: "Short Password",
      }),
    ).rejects.toThrow();
  });
});

describe("auth.login / auth.logout — known testing limitation", () => {
  it("cannot be exercised via createCaller() because they call cookies() from next/headers, which requires a real Next.js request scope", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    await db
      .update(users)
      .set({ passwordHash: hashPassword("correct-horse") })
      .where(eq(users.id, fixtures.users.member1.id));

    // This documents a genuine environment constraint, not a bug: outside
    // an actual HTTP request (e.g. in this direct-caller unit test), the
    // Next.js `cookies()` API throws. login/logout are the only two
    // procedures in the whole app that touch cookies() directly, so this
    // is the only place this limitation applies. Covering these two
    // properly needs an integration-level test (e.g. Playwright hitting
    // the running dev server) rather than a unit test — noted as a gap
    // in behavior-inventory.md rather than silently skipped.
    await expect(
      callerAs(null).auth.login({ email: "member1@test.local", password: "correct-horse" }),
    ).rejects.toThrow("outside a request scope");
  });
});
