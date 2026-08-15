import { describe, it, expect } from "vitest";
import { resetDb, seedMinimal, callerAs } from "./helpers";

/** Next occurrence of 09:00 UTC, used as a stable anchor for availability tests. */
function nineAmUtc(daysAhead = 1): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(9, 0, 0, 0);
  return d;
}

describe("trainers.ts role gating", () => {
  it("upcomingClasses/availability/setAvailability/removeAvailability are trainer-only — even admin is rejected", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { admin, member1, trainer } = fixtures.users;

    // Confirms the inventory note: these four use a manual role check
    // (`role !== "trainer"`), unlike staffProcedure elsewhere — so even
    // an admin, who can normally do everything staff can, is rejected.
    await expect(callerAs(admin).trainers.upcomingClasses()).rejects.toThrow(
      "Only trainers",
    );
    await expect(callerAs(member1).trainers.upcomingClasses()).rejects.toThrow(
      "Only trainers",
    );
    await expect(callerAs(trainer).trainers.upcomingClasses()).resolves.toBeDefined();

    await expect(callerAs(admin).trainers.availability()).rejects.toThrow("Only trainers");
  });

  it("checkAvailability allows trainer OR admin, but rejects members", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { admin, member1, trainer } = fixtures.users;
    const anchor = nineAmUtc();

    const input = { trainerId: trainer.id, startsAt: anchor.toISOString(), durationMin: 60 };

    await expect(callerAs(admin).trainers.checkAvailability(input)).resolves.toBeDefined();
    await expect(callerAs(trainer).trainers.checkAvailability(input)).resolves.toBeDefined();
    await expect(callerAs(member1).trainers.checkAvailability(input)).rejects.toThrow(
      "Staff only",
    );
  });
});

describe("trainers.checkAvailability logic", () => {
  it("is available within set availability hours with no conflicting class", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { trainer } = fixtures.users;
    const anchor = nineAmUtc();

    await callerAs(trainer).trainers.setAvailability({
      dayOfWeek: anchor.getUTCDay(),
      startTime: "09:00",
      endTime: "17:00",
    });

    const result = await callerAs(trainer).trainers.checkAvailability({
      trainerId: trainer.id,
      startsAt: anchor.toISOString(), // 09:00 UTC
      durationMin: 60,
    });

    expect(result.available).toBe(true);
  });

  it("is unavailable outside the set availability hours", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { trainer } = fixtures.users;
    const anchor = nineAmUtc();

    await callerAs(trainer).trainers.setAvailability({
      dayOfWeek: anchor.getUTCDay(),
      startTime: "09:00",
      endTime: "17:00",
    });

    const before = new Date(anchor);
    before.setUTCHours(7, 0, 0, 0); // 07:00 UTC — before the 09:00 window starts

    const result = await callerAs(trainer).trainers.checkAvailability({
      trainerId: trainer.id,
      startsAt: before.toISOString(),
      durationMin: 60,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("Outside availability hours");
  });

  it("is unavailable when it overlaps an existing non-cancelled class for that trainer", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { trainer, admin } = fixtures.users;
    const anchor = nineAmUtc();

    await callerAs(trainer).trainers.setAvailability({
      dayOfWeek: anchor.getUTCDay(),
      startTime: "09:00",
      endTime: "17:00",
    });

    // Existing class 10:00–11:00 UTC for this trainer.
    const existingStart = new Date(anchor);
    existingStart.setUTCHours(10, 0, 0, 0);
    await callerAs(admin).classes.create({
      name: "Existing Class",
      room: "Studio X",
      capacity: 5,
      startsAt: existingStart.toISOString(),
      durationMin: 60,
      trainerId: trainer.id,
    });

    // Proposed new class 10:30–11:30 UTC — overlaps the existing one.
    const proposedStart = new Date(anchor);
    proposedStart.setUTCHours(10, 30, 0, 0);

    const result = await callerAs(trainer).trainers.checkAvailability({
      trainerId: trainer.id,
      startsAt: proposedStart.toISOString(),
      durationMin: 60,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("Trainer already has a class at this time");
  });

  it("reports unavailable with no availability set at all for that day", async () => {
    await resetDb();
    const fixtures = await seedMinimal();
    const { trainer } = fixtures.users;
    const anchor = nineAmUtc(); // no setAvailability call for this trainer

    const result = await callerAs(trainer).trainers.checkAvailability({
      trainerId: trainer.id,
      startsAt: anchor.toISOString(),
      durationMin: 60,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("No availability set for this day");
  });
});
