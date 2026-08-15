import { z } from "zod";
import { and, eq, gte, sql, lte, desc, inArray } from "drizzle-orm";
import {
  users,
  memberships,
  classes,
  bookings,
  payments,
  checkins,
  membershipPlans,
} from "@/db/schema";
import { router, adminProcedure } from "../trpc";

export const adminRouter = router({
  stats: adminProcedure.query(async ({ ctx }) => {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    const [{ totalMembers }] = await ctx.db
      .select({ totalMembers: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.role, "member"));

    const [{ activeMemberships }] = await ctx.db
      .select({ activeMemberships: sql<number>`count(*)` })
      .from(memberships)
      .where(
        and(
          eq(memberships.status, "active"),
          sql`${memberships.endDate} >= ${today}`,
        ),
      );

    const [{ upcomingClasses }] = await ctx.db
      .select({ upcomingClasses: sql<number>`count(*)` })
      .from(classes)
      .where(and(gte(classes.startsAt, now), eq(classes.cancelled, false)));

    const [{ revenueCents }] = await ctx.db
      .select({ revenueCents: sql<number>`coalesce(sum(amount_cents), 0)` })
      .from(payments)
      .where(eq(payments.status, "paid"));

    const [{ totalCheckins }] = await ctx.db
      .select({ totalCheckins: sql<number>`count(*)` })
      .from(checkins);

    const [{ pendingPayments }] = await ctx.db
      .select({ pendingPayments: sql<number>`count(*)` })
      .from(payments)
      .where(eq(payments.status, "pending"));

    return {
      totalMembers: Number(totalMembers),
      activeMemberships: Number(activeMemberships),
      upcomingClasses: Number(upcomingClasses),
      revenueCents: Number(revenueCents),
      totalCheckins: Number(totalCheckins),
      pendingPayments: Number(pendingPayments),
    };
  }),

  classUtilisation: adminProcedure
    .input(z.object({ limit: z.number().default(10) }).default({}))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: classes.id,
          name: classes.name,
          startsAt: classes.startsAt,
          capacity: classes.capacity,
          booked: sql<number>`(
            select count(*) from ${bookings}
            where ${bookings.classId} = ${classes.id}
              and ${bookings.status} in ('booked','attended')
          )`.as("booked"),
        })
        // The leftJoin below isn't for its own columns (none are
        // selected) — it's required to make Drizzle fully qualify
        // ${classes.id} as "classes"."id" in the generated SQL above.
        // Without ANY join, Drizzle renders that reference as a bare
        // "id", which SQLite then resolves to the closest table in the
        // correlated subquery — "bookings", which also has its own "id"
        // column — silently comparing bookings.class_id = bookings.id
        // instead of bookings.class_id = classes.id. Confirmed by
        // inspecting query.toSQL() directly; see behavior-inventory.md
        // finding 14. classes.list has the identical subquery pattern
        // but happens to already have a real join, which is why it was
        // never affected by this.
        .from(classes)
        .leftJoin(users, eq(classes.trainerId, users.id))
        .where(eq(classes.cancelled, false))
        .limit(input.limit);

      return rows.map((r) => ({
        ...r,
        booked: Number(r.booked),
        utilisation: r.capacity ? Number(r.booked) / r.capacity : 0,
      }));
    }),

  revenueByMonth: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        month: sql<string>`strftime('%Y-%m', ${payments.createdAt})`,
        totalCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)`,
      })
      .from(payments)
      .where(eq(payments.status, "paid"))
      .groupBy(sql`strftime('%Y-%m', ${payments.createdAt})`)
      .orderBy(sql`strftime('%Y-%m', ${payments.createdAt}) DESC`);

    return rows.map((r) => ({
      month: r.month,
      totalCents: Number(r.totalCents),
    }));
  }),

  revenueByMethod: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        method: payments.method,
        totalCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(payments)
      .where(eq(payments.status, "paid"))
      .groupBy(payments.method)
      .orderBy(sql`sum(${payments.amountCents}) DESC`);

    return rows.map((r) => ({
      method: r.method,
      totalCents: Number(r.totalCents),
      count: Number(r.count),
    }));
  }),

  expiringMemberships: adminProcedure.query(async ({ ctx }) => {
    const today = new Date().toISOString().slice(0, 10);
    const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const rows = await ctx.db
      .select({
        memberId: users.id,
        memberName: users.name,
        memberEmail: users.email,
        planName: membershipPlans.name,
        expiresAt: memberships.endDate,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .innerJoin(membershipPlans, eq(memberships.planId, membershipPlans.id))
      .where(
        and(
          eq(memberships.status, "active"),
          gte(memberships.endDate, today),
          lte(memberships.endDate, in14Days),
        ),
      )
      .orderBy(memberships.endDate);

    return rows;
  }),

  refundCount: adminProcedure.query(async ({ ctx }) => {
    const [result] = await ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(payments)
      .where(eq(payments.status, "refunded"));

    return { count: Number(result.count) };
  }),

  checkinsPerDay: adminProcedure.query(async ({ ctx }) => {
    const start = new Date();
    start.setDate(start.getDate() - 14);
    const startStr = start.toISOString().slice(0, 10);

    const rows = await ctx.db
      .select({
        date: sql<string>`date(${checkins.checkedInAt})`,
        count: sql<number>`count(*)`,
      })
      .from(checkins)
      .where(sql`date(${checkins.checkedInAt}) >= ${startStr}`)
      .groupBy(sql`date(${checkins.checkedInAt})`)
      .orderBy(sql`date(${checkins.checkedInAt}) DESC`);

    return rows.map((r) => ({
      date: r.date,
      count: Number(r.count),
    }));
  }),

  topTrainers: adminProcedure.query(async ({ ctx }) => {
    const start = new Date();
    start.setDate(start.getDate() - 14);
    const startStr = start.toISOString().slice(0, 10);

    const rows = await ctx.db
      .select({
        trainerId: classes.trainerId,
        trainerName: users.name,
        classCount: sql<number>`count(distinct ${bookings.classId})`,
        attendedCount: sql<number>`count(${bookings.id})`,
      })
      .from(bookings)
      .innerJoin(classes, eq(bookings.classId, classes.id))
      .innerJoin(users, eq(classes.trainerId, users.id))
      .where(
        and(
          eq(bookings.status, "attended"),
          sql`date(${classes.startsAt}) >= ${startStr}`,
        ),
      )
      .groupBy(classes.trainerId, users.name)
      .orderBy(sql`count(${bookings.id}) DESC`)
      .limit(10);

    return rows.map((r) => ({
      trainerId: r.trainerId,
      trainerName: r.trainerName,
      classCount: Number(r.classCount),
      attendedCount: Number(r.attendedCount),
    }));
  }),

  noShowList: adminProcedure.query(async ({ ctx }) => {
    const start = new Date();
    start.setDate(start.getDate() - 14);
    const startStr = start.toISOString().slice(0, 10);

    const rows = await ctx.db
      .select({
        bookingId: bookings.id,
        memberId: users.id,
        memberName: users.name,
        memberEmail: users.email,
        className: classes.name,
        classDate: classes.startsAt,
        trainerId: classes.trainerId,
      })
      .from(bookings)
      .innerJoin(classes, eq(bookings.classId, classes.id))
      .innerJoin(users, eq(bookings.userId, users.id))
      .where(
        and(
          eq(bookings.status, "no_show"),
          sql`date(${classes.startsAt}) >= ${startStr}`,
        ),
      )
      .orderBy(sql`${classes.startsAt} DESC`);

    const trainerIds = [...new Set(rows.map((r) => r.trainerId).filter((id) => id != null))];
    const trainers = new Map<number | null, string>();

    if (trainerIds.length > 0) {
      const trainerRows = await ctx.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, trainerIds as number[]));

      trainerRows.forEach((t) => {
        trainers.set(t.id, t.name);
      });
    }

    return rows.map((r) => ({
      bookingId: r.bookingId,
      memberId: r.memberId,
      memberName: r.memberName,
      memberEmail: r.memberEmail,
      className: r.className,
      classDate: r.classDate,
      trainerId: r.trainerId,
      trainerName: r.trainerId ? trainers.get(r.trainerId) : undefined,
    }));
  }),
});
