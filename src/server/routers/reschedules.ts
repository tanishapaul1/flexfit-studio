import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  reschedules,
  bookings,
  classes,
  memberships,
} from "@/db/schema";
import { router, protectedProcedure } from "../trpc";
import { hoursUntil, isClassFull, promoteNextWaitlisted } from "../domain/booking-core";

/**
 * Members may reschedule free of charge up to this many hours before the
 * original class starts. This is more generous than cancellation policy.
 */
export const FREE_RESCHEDULE_HOURS = 4;

type TRPCErrorCode = "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST" | "CONFLICT";

type RescheduleValidation =
  | {
      valid: true;
      originalBooking: typeof bookings.$inferSelect;
      originalClass: typeof classes.$inferSelect;
      targetClass: typeof classes.$inferSelect;
      targetIsFull: boolean;
    }
  | { valid: false; code: TRPCErrorCode; reason: string };

/**
 * Shared by both `reschedule` (mutation, throws on invalid) and
 * `validateReschedule` (query, returns the result as data). Previously
 * these two procedures duplicated ~80 lines of identical checks — see
 * behavior-inventory.md finding 6. The `code` field lets the mutation
 * throw the exact same TRPCError codes it always did, while the query
 * just ignores `code` and returns `{ valid: false, reason }` as before —
 * so both callers keep their original external behavior exactly.
 *
 * Also applies the cross-table capacity check (booking-core.ts's
 * isClassFull) to the target class, extending the finding 1 fix here
 * too — the target class's fullness should account for corporate
 * bookings just like every other capacity check in the app now does.
 */
async function validateRescheduleRequest(
  db: typeof import("@/db").db,
  userId: number,
  fromBookingId: number,
  toClassId: number,
): Promise<RescheduleValidation> {
  const originalRow = await db
    .select({ booking: bookings, cls: classes })
    .from(bookings)
    .innerJoin(classes, eq(bookings.classId, classes.id))
    .where(eq(bookings.id, fromBookingId))
    .get();

  if (!originalRow) {
    return { valid: false, code: "NOT_FOUND", reason: "Booking not found." };
  }

  const originalBooking = originalRow.booking;
  const originalClass = originalRow.cls;

  if (originalBooking.userId !== userId) {
    return { valid: false, code: "FORBIDDEN", reason: "You cannot reschedule this booking." };
  }

  if (originalBooking.status !== "booked" && originalBooking.status !== "waitlisted") {
    return { valid: false, code: "BAD_REQUEST", reason: "This booking is no longer active." };
  }

  const hoursBeforeOriginal = hoursUntil(originalClass.startsAt);
  if (hoursBeforeOriginal < FREE_RESCHEDULE_HOURS) {
    return {
      valid: false,
      code: "BAD_REQUEST",
      reason: `You can only reschedule up to ${FREE_RESCHEDULE_HOURS} hours before the class starts.`,
    };
  }

  const targetClass = await db.select().from(classes).where(eq(classes.id, toClassId)).get();
  if (!targetClass) {
    return { valid: false, code: "NOT_FOUND", reason: "Target class not found." };
  }

  if (targetClass.name !== originalClass.name) {
    return {
      valid: false,
      code: "BAD_REQUEST",
      reason: "You can only reschedule to a class with the same name.",
    };
  }

  if (targetClass.id === originalClass.id) {
    return { valid: false, code: "BAD_REQUEST", reason: "You are already booked for this class." };
  }

  if (hoursUntil(targetClass.startsAt) <= 0) {
    return { valid: false, code: "BAD_REQUEST", reason: "This class has already started." };
  }

  if (targetClass.cancelled) {
    return { valid: false, code: "BAD_REQUEST", reason: "This class has been cancelled." };
  }

  const existingBooking = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.classId, targetClass.id),
        eq(bookings.userId, userId),
        sql`${bookings.status} in ('booked', 'waitlisted')`,
      ),
    )
    .get();

  if (existingBooking) {
    return {
      valid: false,
      code: "CONFLICT",
      reason: "You already have an active booking for this class.",
    };
  }

  const targetIsFull = await isClassFull(db, targetClass.id, targetClass.capacity);

  return { valid: true, originalBooking, originalClass, targetClass, targetIsFull };
}

export const reschedulesRouter = router({
  reschedule: protectedProcedure
    .input(
      z.object({
        fromBookingId: z.number(),
        toClassId: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await validateRescheduleRequest(
        ctx.db,
        ctx.user.id,
        input.fromBookingId,
        input.toClassId,
      );

      if (!result.valid) {
        throw new TRPCError({ code: result.code, message: result.reason });
      }

      const { originalBooking, originalClass, targetClass, targetIsFull } = result;

      // Create the new booking (don't charge credits, they keep what they spent).
      const newBooking = await ctx.db
        .insert(bookings)
        .values({
          classId: targetClass.id,
          userId: ctx.user.id,
          membershipId: originalBooking.membershipId,
          status: targetIsFull ? "waitlisted" : "booked",
          creditsUsed: originalBooking.creditsUsed,
        })
        .returning()
        .get();

      // Cancel the original booking.
      await ctx.db
        .update(bookings)
        .set({
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, originalBooking.id));

      // If the original booking was a confirmed spot, rescheduling away
      // from it has the exact same real-world effect as cancelling it —
      // a spot just opened up. Promote whoever's waited longest for it,
      // considering both personal and corporate waitlists. Previously
      // this never happened at all — see behavior-inventory.md finding 5.
      if (originalBooking.status === "booked") {
        await promoteNextWaitlisted(ctx.db, {
          id: originalClass.id,
          creditCost: originalClass.creditCost,
        });
      }

      // Record the reschedule.
      await ctx.db.insert(reschedules).values({
        userId: ctx.user.id,
        fromBookingId: originalBooking.id,
        toBookingId: newBooking.id,
        fromClassId: originalClass.id,
        toClassId: targetClass.id,
      });

      return {
        ok: true,
        newBooking,
        newStatus: targetIsFull ? "waitlisted" : "booked",
      };
    }),

  history: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: reschedules.id,
        rescheduledAt: reschedules.rescheduledAt,
        fromClassName: classes.name,
        fromClassTime: sql<string>`(
          SELECT ${classes.startsAt} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.fromClassId}
        )`,
        fromClassRoom: sql<string>`(
          SELECT ${classes.room} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.fromClassId}
        )`,
        toClassName: sql<string>`(
          SELECT ${classes.name} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.toClassId}
        )`,
        toClassTime: sql<string>`(
          SELECT ${classes.startsAt} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.toClassId}
        )`,
        toClassRoom: sql<string>`(
          SELECT ${classes.room} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.toClassId}
        )`,
      })
      .from(reschedules)
      .innerJoin(classes, eq(reschedules.fromClassId, classes.id))
      .where(eq(reschedules.userId, ctx.user.id))
      .orderBy(desc(reschedules.rescheduledAt));
  }),

  validateReschedule: protectedProcedure
    .input(
      z.object({
        fromBookingId: z.number(),
        toClassId: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const result = await validateRescheduleRequest(
        ctx.db,
        ctx.user.id,
        input.fromBookingId,
        input.toClassId,
      );

      if (!result.valid) {
        return { valid: false, reason: result.reason };
      }

      return { valid: true, targetIsFull: result.targetIsFull };
    }),
});
