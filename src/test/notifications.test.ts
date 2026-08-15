import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { users, notifications } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resetDb, seedMinimal, callerAs } from "./helpers";

describe("notifications.unreadCount / list / markAllAsRead", () => {
  it("counts only unread, and markAllAsRead clears the count", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1 } = fixtures.users;

    await db.insert(notifications).values([
      { userId: member1.id, type: "announcement", title: "A", message: "a", read: false },
      { userId: member1.id, type: "announcement", title: "B", message: "b", read: false },
      { userId: member1.id, type: "announcement", title: "C", message: "c", read: true },
    ]);

    const caller = callerAs(member1);
    expect(await caller.notifications.unreadCount()).toBe(2);

    await caller.notifications.markAllAsRead();
    expect(await caller.notifications.unreadCount()).toBe(0);
  });

  it("only returns the calling user's own notifications", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1, member2 } = fixtures.users;

    await db.insert(notifications).values({
      userId: member2.id,
      type: "announcement",
      title: "Not yours",
      message: "x",
    });

    const list = await callerAs(member1).notifications.list();
    expect(list).toHaveLength(0);
  });
});

describe("Finding 9 (FIXED): notifications.broadcast no longer reaches deactivated accounts", () => {
  it("excludes a deactivated member, matching what the variable name activeMembers always implied", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { member1, admin } = fixtures.users;

    await db.update(users).set({ active: false }).where(eq(users.id, member1.id));

    const result = await callerAs(admin).notifications.broadcast({
      title: "Studio closed",
      message: "Closed for maintenance",
    });

    // 3 members seeded (member1, member2, member3); member1 is now
    // deactivated, so only 2 should receive it. Before the fix, this
    // was 3 — the query only filtered by role === "member", never by
    // users.active — see behavior-inventory.md finding 9.
    expect(result.count).toBe(2);

    const member1Notifications = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, member1.id));
    expect(member1Notifications).toHaveLength(0); // no longer receives it
  });

  it("does not send to trainers or admins, only role='member'", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { trainer, admin } = fixtures.users;

    await callerAs(admin).notifications.broadcast({ title: "T", message: "m" });

    const trainerNotifications = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, trainer.id));
    expect(trainerNotifications).toHaveLength(0);
  });
});
