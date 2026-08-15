import { db } from "@/db";
import {
  users,
  memberships,
  membershipPlans,
  classes,
  bookings,
  corporateBookings,
  checkins,
  companies,
  companyMembers,
  notifications,
  sessions,
  payments,
  reschedules,
  trainerAvailability,
} from "@/db/schema";
import { appRouter } from "@/server/routers/_app";
import type { User } from "@/db/schema";

/**
 * Wipes every table. Order matters because of foreign keys: children
 * before parents. Called in beforeEach so every test starts from a
 * known-empty database rather than depending on test execution order.
 *
 * Covers all 14 tables in src/db/schema.ts as of this writing. If a new
 * table is added to the schema, add it here too — a missing table here
 * surfaces as a cryptic SQLITE_CONSTRAINT_FOREIGNKEY error on the *next*
 * test's cleanup, not the test that actually created the row, which is
 * exactly what happened twice while building this suite (reschedules,
 * then trainerAvailability, were both missed on first pass).
 */
export async function resetDb() {
  await db.delete(reschedules);
  await db.delete(trainerAvailability);
  await db.delete(checkins);
  await db.delete(bookings);
  await db.delete(corporateBookings);
  await db.delete(companyMembers);
  await db.delete(companies);
  await db.delete(payments);
  await db.delete(memberships);
  await db.delete(membershipPlans);
  await db.delete(notifications);
  await db.delete(classes);
  await db.delete(sessions);
  await db.delete(users);
}

/** ISO datetime `hours` from now — used to build classes at predictable times. */
export function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

/** Today's date as YYYY-MM-DD, matching how the app stores membership dates. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Minimal, deterministic fixture set — small enough to reason about by
 * hand, unlike the large randomized src/db/seed.ts used for local dev.
 * Extend this as new tests need more scenarios.
 */
export async function seedMinimal() {
  const [admin, trainer, member1, member2, member3] = await db
    .insert(users)
    .values([
      { email: "admin@test.local", passwordHash: "x", name: "Admin", role: "admin" },
      { email: "trainer@test.local", passwordHash: "x", name: "Trainer", role: "trainer" },
      { email: "member1@test.local", passwordHash: "x", name: "Member One", role: "member" },
      { email: "member2@test.local", passwordHash: "x", name: "Member Two", role: "member" },
      { email: "member3@test.local", passwordHash: "x", name: "Member Three", role: "member" },
    ])
    .returning();

  const [limitedPlan, unlimitedPlan] = await db
    .insert(membershipPlans)
    .values([
      { name: "Basic", priceCents: 5000, durationDays: 30, classCredits: 5 },
      { name: "Unlimited", priceCents: 15000, durationDays: 30, classCredits: 999 },
    ])
    .returning();

  // member1: limited plan, 5 credits. member2: unlimited plan.
  // member3: no active membership at all (used for "requires membership" tests).
  const [membership1, membership2] = await db
    .insert(memberships)
    .values([
      {
        userId: member1.id,
        planId: limitedPlan.id,
        startDate: today(),
        endDate: daysFromToday(30),
        creditsRemaining: 5,
        status: "active",
      },
      {
        userId: member2.id,
        planId: unlimitedPlan.id,
        startDate: today(),
        endDate: daysFromToday(30),
        creditsRemaining: 999,
        status: "active",
      },
    ])
    .returning();

  // A single-capacity class starting well in the future, so the second
  // person to book it always lands on the waitlist. creditCost 1.
  const [smallClass] = await db
    .insert(classes)
    .values({
      name: "Yoga",
      trainerId: trainer.id,
      room: "Studio A",
      capacity: 1,
      startsAt: hoursFromNow(48),
      durationMin: 60,
      creditCost: 1,
    })
    .returning();

  // A roomier class, and one starting soon (inside the 12h cancellation
  // window) for testing the "no refund" path.
  const [roomyClass] = await db
    .insert(classes)
    .values({
      name: "Spin",
      trainerId: trainer.id,
      room: "Studio B",
      capacity: 10,
      startsAt: hoursFromNow(48),
      durationMin: 45,
      creditCost: 1,
    })
    .returning();

  const [soonClass] = await db
    .insert(classes)
    .values({
      name: "HIIT",
      trainerId: trainer.id,
      room: "Studio C",
      capacity: 10,
      startsAt: hoursFromNow(6), // inside the 12h free-cancellation window
      durationMin: 30,
      creditCost: 1,
    })
    .returning();

  // A single-capacity class reserved for corporate-vs-personal capacity
  // tests, kept separate from smallClass so those test suites don't
  // interfere with each other.
  const [sharedCapacityClass] = await db
    .insert(classes)
    .values({
      name: "Pilates",
      trainerId: trainer.id,
      room: "Studio D",
      capacity: 1,
      startsAt: hoursFromNow(48),
      durationMin: 45,
      creditCost: 1,
    })
    .returning();

  // Reschedule fixtures: same name ("Yoga") as smallClass, so they're
  // valid reschedule targets from a smallClass booking. yogaAlt has room
  // to spare (happy-path target); yogaAltFull has capacity 1, meant to
  // be filled by a test itself before rescheduling into it.
  const [yogaAlt] = await db
    .insert(classes)
    .values({
      name: "Yoga",
      trainerId: trainer.id,
      room: "Studio E",
      capacity: 10,
      startsAt: hoursFromNow(72),
      durationMin: 60,
      creditCost: 1,
    })
    .returning();

  const [yogaAltFull] = await db
    .insert(classes)
    .values({
      name: "Yoga",
      trainerId: trainer.id,
      room: "Studio F",
      capacity: 1,
      startsAt: hoursFromNow(72),
      durationMin: 60,
      creditCost: 1,
    })
    .returning();

  // Starts in 2h — inside the 4h reschedule window, so rescheduling
  // AWAY FROM this class should be rejected.
  const [yogaStartingSoon] = await db
    .insert(classes)
    .values({
      name: "Yoga",
      trainerId: trainer.id,
      room: "Studio G",
      capacity: 1,
      startsAt: hoursFromNow(2),
      durationMin: 60,
      creditCost: 1,
    })
    .returning();

  const [company] = await db
    .insert(companies)
    .values({
      name: "Acme Corp",
      contactEmail: "hr@acme.test",
      creditPoolBalance: 10,
      active: true,
    })
    .returning();

  // member3 (otherwise unused for personal-membership tests) is linked
  // to the company, giving us a corporate booker.
  await db.insert(companyMembers).values({
    userId: member3.id,
    companyId: company.id,
  });

  return {
    users: { admin, trainer, member1, member2, member3 },
    plans: { limitedPlan, unlimitedPlan },
    memberships: { membership1, membership2 },
    classes: {
      smallClass,
      roomyClass,
      soonClass,
      sharedCapacityClass,
      yogaAlt,
      yogaAltFull,
      yogaStartingSoon,
    },
    company,
  };
}

/**
 * Builds a tRPC caller acting as the given user, bypassing HTTP and
 * cookies entirely — the standard way to test tRPC routers directly.
 * Pass `null` for an unauthenticated (public) caller.
 */
export function callerAs(user: User | null) {
  return appRouter.createCaller({ db, user, token: user ? "test-token" : undefined });
}
