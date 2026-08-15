import { z } from "zod";
import { and, eq, desc, not, sql } from "drizzle-orm";
import { notifications, users } from "@/db/schema";
import { router, protectedProcedure, adminProcedure } from "../trpc";

export const notificationsRouter = router({
  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    const [{ count }] = await ctx.db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ctx.user.id),
          not(notifications.read)
        )
      );

    return Number(count) || 0;
  }),

  list: protectedProcedure
    .input(z.object({ limit: z.number().default(50) }).default({}))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, ctx.user.id))
        .orderBy(desc(notifications.createdAt))
        .limit(input.limit);
    }),

  markAllAsRead: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .update(notifications)
      .set({ read: true })
      .where(
        and(
          eq(notifications.userId, ctx.user.id),
          not(notifications.read)
        )
      );

    return { ok: true };
  }),

  broadcast: adminProcedure
    .input(
      z.object({
        title: z.string(),
        message: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Filter by active status too, matching what the variable name
      // always implied — previously this only filtered by role, so
      // deactivated accounts silently received broadcasts too. See
      // behavior-inventory.md finding 9.
      const activeMembers = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "member"), eq(users.active, true)));

      if (activeMembers.length === 0) {
        return { ok: true, count: 0 };
      }

      await ctx.db.insert(notifications).values(
        activeMembers.map((member) => ({
          userId: member.id,
          type: "announcement" as const,
          title: input.title,
          message: input.message,
        }))
      );

      return { ok: true, count: activeMembers.length };
    }),
});
