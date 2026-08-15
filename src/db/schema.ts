import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, real } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  role: text("role", { enum: ["member", "trainer", "admin"] })
    .notNull()
    .default("member"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  token: text("token").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const membershipPlans = sqliteTable("membership_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  priceCents: integer("price_cents").notNull(),
  durationDays: integer("duration_days").notNull(),
  classCredits: integer("class_credits").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const memberships = sqliteTable("memberships", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  planId: integer("plan_id")
    .notNull()
    .references(() => membershipPlans.id),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  creditsRemaining: integer("credits_remaining").notNull().default(0),
  status: text("status", { enum: ["active", "expired", "cancelled", "frozen"] })
    .notNull()
    .default("active"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const classes = sqliteTable("classes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  trainerId: integer("trainer_id").references(() => users.id),
  room: text("room").notNull(),
  capacity: integer("capacity").notNull(),
  startsAt: text("starts_at").notNull(),
  durationMin: integer("duration_min").notNull().default(60),
  creditCost: integer("credit_cost").notNull().default(1),
  cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const bookings = sqliteTable("bookings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  classId: integer("class_id")
    .notNull()
    .references(() => classes.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  membershipId: integer("membership_id").references(() => memberships.id),
  status: text("status", {
    enum: ["booked", "cancelled", "attended", "no_show", "waitlisted"],
  })
    .notNull()
    .default("booked"),
  creditsUsed: integer("credits_used").notNull().default(0),
  bookedAt: text("booked_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  cancelledAt: text("cancelled_at"),
});

export const checkins = sqliteTable("checkins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  bookingId: integer("booking_id").references(() => bookings.id),
  // Added to fix behavior-inventory.md finding 2: corporate check-ins
  // previously always left bookingId null with no way to trace them back
  // to the corporate booking that was checked in, which silently
  // undercounted attendance in bookings.checkinCountFor (it only joined
  // on bookingId). A corporate check-in now sets this instead of
  // bookingId, and checkinCountFor accounts for both — see
  // booking-core.ts's checkinCountForClass.
  corporateBookingId: integer("corporate_booking_id").references(
    () => corporateBookings.id,
  ),
  checkedInAt: text("checked_in_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  source: text("source", { enum: ["front_desk", "kiosk", "app"] })
    .notNull()
    .default("front_desk"),
});

export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  membershipId: integer("membership_id").references(() => memberships.id),
  amountCents: integer("amount_cents").notNull(),
  method: text("method", { enum: ["card", "cash", "upi", "transfer"] }).notNull(),
  status: text("status", { enum: ["pending", "paid", "failed", "refunded"] })
    .notNull()
    .default("pending"),
  reference: text("reference"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  type: text("type", {
    enum: ["waitlist_promotion", "class_cancelled", "membership_expiring", "announcement"],
  })
    .notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const trainerAvailability = sqliteTable("trainer_availability", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  trainerId: integer("trainer_id")
    .notNull()
    .references(() => users.id),
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const reschedules = sqliteTable("reschedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  fromBookingId: integer("from_booking_id")
    .notNull()
    .references(() => bookings.id),
  toBookingId: integer("to_booking_id")
    .notNull()
    .references(() => bookings.id),
  fromClassId: integer("from_class_id")
    .notNull()
    .references(() => classes.id),
  toClassId: integer("to_class_id")
    .notNull()
    .references(() => classes.id),
  rescheduledAt: text("rescheduled_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const companies = sqliteTable("companies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  contactEmail: text("contact_email").notNull(),
  creditPoolBalance: integer("credit_pool_balance").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const companyMembers = sqliteTable("company_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const corporateBookings = sqliteTable("corporate_bookings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  classId: integer("class_id")
    .notNull()
    .references(() => classes.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id),
  status: text("status", {
    enum: ["booked", "cancelled", "attended", "no_show", "waitlisted"],
  })
    .notNull()
    .default("booked"),
  creditsUsed: integer("credits_used").notNull().default(0),
  bookedAt: text("booked_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  cancelledAt: text("cancelled_at"),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type MembershipPlan = typeof membershipPlans.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type GymClass = typeof classes.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Checkin = typeof checkins.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type TrainerAvailability = typeof trainerAvailability.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type CompanyMember = typeof companyMembers.$inferSelect;
export type CorporateBooking = typeof corporateBookings.$inferSelect;
export type Reschedule = typeof reschedules.$inferSelect;
