# FlexFit Studio — Behavior Inventory

Purpose: a complete map of what the app currently does, built by reading
every router before making any refactor decisions. This is the reference
point for "does the refactored app behave exactly the same as before."

## 1. Data model summary

14 tables, clustering into six areas:

- **Identity** — `users` (member/trainer/admin), `sessions` (DB-backed
  token auth, not JWT)
- **Membership** — `membershipPlans` (catalog), `memberships` (a user's
  subscription to a plan)
- **Scheduling** — `classes`, `trainerAvailability`
- **Individual booking flow** — `bookings`, `checkins`, `reschedules`,
  `notifications`
- **Money** — `payments`
- **Corporate** — `companies`, `companyMembers`, `corporateBookings`
  (a fully parallel booking system for company-sponsored members)

Key structural facts:
- `bookings` and `corporateBookings` are near-identical schemas kept
  fully separate.
- Credits live in two independent pools: `memberships.creditsRemaining`
  (personal) and `companies.creditPoolBalance` (corporate).
- `UNLIMITED_CREDITS = 999` (see `bookings.ts`) is a sentinel value, not
  a boolean flag, for "this plan never decrements."

## 2. Permission tiers (`src/server/trpc.ts`)

Defined once, composed everywhere except `trainers.ts` (see Finding 7):

| Tier | Requirement |
|---|---|
| `publicProcedure` | none |
| `protectedProcedure` | valid, non-expired session cookie |
| `staffProcedure` | protected + role is `trainer` or `admin` |
| `adminProcedure` | protected + role is `admin` |

Auth is DB-backed: cookie → token → join `sessions`→`users` → check
`expiresAt`, on every request via `createContext()`.

## 3. Endpoint-by-endpoint rules

### auth.ts
- `register` always forces `role: "member"` — no self-service staff/admin signup.
- `login` checks password **and** `user.active`; deactivated accounts are rejected even with correct credentials.
- Sessions last 30 days (`SESSION_DAYS`), random 32-byte hex token, cookie is `httpOnly`, `sameSite: lax`.
- `login`/`logout` call `cookies()` from `next/headers`, which requires a real Next.js request scope — **these two cannot be unit-tested via `createCaller()`** (confirmed: throws "cookies was called outside a request scope"). They're the only procedures in the app with this constraint. Covering them properly needs an integration-level test (e.g. Playwright against the running dev server), not a unit test. Noted as a real gap in this suite's coverage, not silently skipped.

### bookings.ts (personal)
- `FREE_CANCELLATION_HOURS = 12`, `UNLIMITED_CREDITS = 999`.
- `book`: class must exist, not cancelled, not started · no duplicate booked/waitlisted entry for same class · requires an active membership (`endDate >= today`) · credit check skipped if unlimited · capacity counts only `status = 'booked'` rows in `bookings` · full → `waitlisted` (0 credits charged); not full → `booked` (credits charged immediately).
- `cancel`: owner or staff only · only `booked`/`waitlisted` can be cancelled · refund only if ≥12h before start **and** credits were used · cancelling a `booked` (not `waitlisted`) row promotes the longest-waiting waitlisted member. The promoted booking's `creditsUsed` is always set to the class's `creditCost`, but the membership balance is only decremented if the promoted member is on a *limited* plan — the `UNLIMITED_CREDITS` guard applies at promotion time too, not just at initial booking. (Confirmed by test; see `bookings.test.ts`.)
- `markAttended` (staff): only from `booked` → `attended`, logs a linked `checkins` row.
- `waitlisted` (member): returns own waitlisted bookings with computed queue position (N+1 query per row — refactor candidate if behavior is preserved).

### classes.ts
- `list`/`byId`: public.
- `create`/`update`: `staffProcedure` (admin or trainer).
- `cancel`: `adminProcedure` only — trainers cannot cancel classes. Marks class cancelled and force-cancels all `booked` bookings, but **does not refund credits or promote waitlists** (see Finding 4).

### reschedules.ts
- `FREE_RESCHEDULE_HOURS = 4` (more lenient than the 12h cancellation window).
- Target class must have the **same name** as the original, must not be the same class, must not have started, must not be cancelled.
- Credits are carried over at the original amount, not re-charged.
- Cancels the original booking by direct status update, **bypassing `bookings.cancel`** — so rescheduling away from a `booked` slot never promotes a waitlisted member (see Finding 5).
- `validateReschedule` duplicates all of `reschedule`'s validation logic for dry-run checks (see Finding 6).

### corporate-bookings.ts
- Mirrors `bookings.ts` closely. Differences: `CORPORATE_FREE_CANCELLATION_HOURS = 24`; credits drawn from `company.creditPoolBalance` instead of a membership; capacity check counts only `corporateBookings` rows (see Finding 1); `markAttended` always inserts `checkins.bookingId = null` (see Finding 2).
- No corporate equivalent of the `waitlisted` (queue position) or `upcomingForMember` endpoints.

### admin.ts (reporting, all `adminProcedure`)
- `stats`, `classUtilisation`, `revenueByMonth`, `revenueByMethod`, `expiringMemberships`, `refundCount`, `checkinsPerDay`, `topTrainers`, `noShowList`.
- All utilisation/no-show queries look only at `bookings`, never `corporateBookings` — consistent with Finding 1, but means the dashboard is blind to corporate activity.
- Heavy use of raw `sql` template literals for SQLite date functions (`strftime`, `date()`) — no type safety here, verify carefully if touched.

### admin-companies.ts (all `adminProcedure`)
- Standard CRUD for companies + `topUp` (add credits) + `linkMember`/`unlinkMember`.
- `linkMember` only allows `role === "member"` users to be linked.

### members.ts
- `profile`/`updateProfile`: `protectedProcedure`, self-service.
- `search`/`byId`/`lookupByEmailOrPhone`: `staffProcedure`.
- `setActive`/`setRole`: `adminProcedure`.
- `byId` explicitly strips `passwordHash` before returning; `search` avoids the issue by selecting only specific columns. Both patterns must be preserved.

### trainers.ts
- **Does not use `staffProcedure`/`adminProcedure`.** Every handler manually checks `ctx.user.role !== "trainer"` inline (see Finding 7).
- `checkAvailability` allows trainer OR admin — functionally identical to what `staffProcedure` already provides elsewhere.
- Overlap math in `checkAvailability` uses `getUTCDay()`/`getUTCHours()`, while `hoursUntil()` elsewhere uses local `Date` arithmetic — mixed UTC/local handling, verify before touching.

### payments.ts
- `mine`: self-service. `all`/`markPaid`/`refund`: `adminProcedure`.
- `refund` cancels the associated membership (`status: "cancelled"`) but does **not** reverse `creditsRemaining` or unwind bookings already made with those credits.

### plans.ts
- `subscribe`: creates a new membership immediately, `payments` row is inserted already `status: "paid"` (no pending step).
- No check for an existing active membership — a user can hold multiple simultaneously. `activeMembershipFor()` always picks the one with the furthest `endDate`; older memberships remain in the table but effectively become unreachable for booking.

### notifications.ts
- `unreadCount`/`list`/`markAllAsRead`: self-service.
- `broadcast` (admin): variable is named `activeMembers` but the query only filters by `role === "member"`, **not** by `users.active` — deactivated accounts still receive broadcasts (see Finding 9).

## 4. Frontend architecture notes (`src/app`)

- Next.js App Router — folder structure under `src/app` is the route
  structure (e.g. `admin/companies/page.tsx` → `/admin/companies`).
- Client-side data layer: React Query + tRPC's `httpBatchLink`, batching
  simultaneous queries into one HTTP call. `staleTime: 5000` (5s), `retry: 1`
  by default (`providers.tsx`).
- `NavBar` polls `notifications.unreadCount` every 30s
  (`refetchInterval: 30000`) while a user is logged in.
- **`/admin/companies` has no NavBar link** — reachable only by direct URL.
  Confirm whether intentional before changing anything about it.
- **No page ever guards access via redirect, except `/login`.** Every
  role-gated page (admin, trainer, kiosk, etc.) simply fires its tRPC
  query; if the backend throws `UNAUTHORIZED`/`FORBIDDEN`, the page
  renders the raw `error.message` as inline text in place of the content.
  The user stays on the same URL. This is consistent across every
  protected page in the app — treat it as a deliberate pattern, not an
  oversight, unless told otherwise.
- Login always redirects to `/dashboard` after success, regardless of
  the user's role (an admin lands on the member dashboard, not `/admin`).

## 6. Test suite (`src/test/`)

Before any refactoring begins, we built an executable test suite against
the *current* app to (a) create a safety net for the refactor and (b)
verify our documented understanding against real behavior rather than
just reading code. 21 tests, 3 files:

- `bookings.test.ts` — personal booking/cancel rules, including credit
  deduction, waitlisting, refund windows, and waitlist promotion.
- `corporate-bookings.test.ts` — corporate booking rules, and a
  dedicated test that concretely reproduces **Finding 1**: a capacity-1
  class accepting both a personal and a corporate booking simultaneously.
- `reschedules.test.ts` — reschedule rules (same-name requirement, 4h
  window, credit carry-over), and a dedicated test reproducing
  **Finding 5**: rescheduling away from a full class does not promote
  the waitlist, unlike an explicit cancel.

Setup: `pnpm test` runs `pretest` first (`scripts/db-push-test.mjs`),
which pushes the schema to an isolated `test.db`, kept fully separate
from dev data (`flexfit.db`). Each test resets all tables and reseeds
small, deterministic fixtures (`src/test/helpers.ts`) — not the large
randomized `src/db/seed.ts` used for local dev, since exact assertions
need predictable data. Router logic is called directly via tRPC's
`createCaller()`, bypassing HTTP and cookies entirely.

**One assumption in this document was corrected by the test suite**: we
initially assumed waitlist promotion always deducts the promoted
member's credits. The first test run failed and revealed the
`UNLIMITED_CREDITS` guard (see `bookings.ts` §3) also applies at
promotion time, not just initial booking — an unlimited-plan member
promoted from a waitlist is never charged. Section 3 above has been
corrected accordingly.

## 7. Findings — ranked by significance

**Status as of the completed refactor** (see `refactor-decisions.md` for the full reasoning behind each decision): 10 of 15 findings were fixed, with tests proving each fix; 5 were deliberately documented and left as-is.

1. ✅ **FIXED.** **Class capacity is not shared between `bookings` and `corporateBookings`.** Each table's capacity check only counts its own rows, so a room can be double-booked across personal + corporate members. Likely bug. → Fixed via the shared `booking-core.ts`'s `isClassFull`, which counts confirmed rows across both tables. Proven in `corporate-bookings.test.ts`.
2. ✅ **FIXED.** **Corporate check-ins never set `checkins.bookingId`**, so `bookings.checkinCountFor` (which joins on `bookingId`) undercounts attendance for classes with corporate attendees. Likely bug. → Fixed by adding a `corporateBookingId` column and a shared `checkinCountForClass()` that sums both. Proven with a mixed-attendance test.
3. 📝 **DOCUMENTED, LEFT AS-IS.** **`waitlist_promotion`, `class_cancelled`, and `membership_expiring` notification types exist in the schema and seed data but are never triggered by any application code.** Looks wired up; isn't. A missing feature, not a bug — noted as future work.
4. ✅ **FIXED.** **`classes.cancel` skips credit refunds and waitlist promotion, and leaves waitlisted bookings orphaned.** It only force-cancels rows with `status: 'booked'` — any `waitlisted` rows for that class are never touched, so they remain `"waitlisted"`, permanently pointing at a class that no longer runs. Unlike `bookings.cancel`. Judgment call: intentional (studio-cancelled ≠ member-cancelled) or a gap. Confirmed by test; see `classes.test.ts`. → Fixed via the new `cancelClassBookings()` in booking-core.ts: refunds booked bookings (personal *and* corporate, extending the original finding's scope) and cancels waitlisted rows instead of orphaning them. No time-window check applies, since the cancellation wasn't the member's choice.
5. ✅ **FIXED.** **Rescheduling bypasses `bookings.cancel` entirely**, so it never triggers waitlist promotion even though a confirmed spot is freed. Judgment call, same category as #4. → Fixed by having `reschedules.ts` call the same shared `promoteNextWaitlisted()` that `bookings.cancel` uses.
6. ✅ **FIXED.** **`reschedule` and `validateReschedule` duplicate ~80 lines of validation.** Safe, well-justified refactor target: extract a shared validation function. → Extracted into `validateRescheduleRequest()`, shared by both procedures, preserving each one's original error codes/response shape exactly.
7. ✅ **FIXED.** **`trainers.ts` reimplements role checks manually** instead of using the `staffProcedure`/`adminProcedure` middleware pattern used everywhere else. Refactor target: introduce a `trainerProcedure`, and reuse `staffProcedure` where the check is literally "trainer or admin." → Added `trainerProcedure` to `trpc.ts`; `checkAvailability` now uses `staffProcedure` directly instead of duplicating that exact check.
8. ⚠️ **PARTIALLY ADDRESSED.** **Multiple simultaneous active memberships are possible** with no consolidation; older ones become dead weight. Judgment call. Confirmed by test; also surfaced a related subtlety: `activeMembershipFor`'s `orderBy(desc(endDate))` has no defined tiebreaker, so if two memberships share the same computed `endDate` (e.g. same plan duration), which one "wins" for booking purposes is effectively undefined behavior, not deterministic business logic. → The *possibility* of multiple memberships is a product decision left as-is (documented). The *undefined tiebreak* was fixed with a deterministic secondary sort (`desc(endDate), desc(id)`).
9. ✅ **FIXED.** **`notifications.broadcast` sends to deactivated accounts** despite a variable name implying otherwise. Likely bug. → One-line fix: added the `active` filter the variable name always implied.
10. 📝 **DOCUMENTED, LEFT AS-IS.** **`UNLIMITED_CREDITS = 999`** is a magic-number sentinel scattered across `bookings.ts` and `corporate-bookings.ts` (implicitly, via the same pattern) — easy to break silently during a careless refactor. → The constant itself was centralized into `booking-core.ts` as part of the broader migration, removing the duplication risk. Replacing the sentinel entirely with a proper boolean schema column is noted as potential future work, not done now.
11. 📝 **DOCUMENTED, LEFT AS-IS.** **No page-level route guards exist anywhere except `/login`'s post-success redirect.** All access control is enforced purely by the backend throwing errors, which pages render as inline text. Consistent across the whole app — a real architectural pattern to preserve, not an accidental gap.
12. 📝 **DOCUMENTED, LEFT AS-IS.** **`/admin/companies` has no NavBar link**, unlike every other admin page. Confirm intent before deciding whether to "fix" the missing nav link during refactor.
13. 📝 **DOCUMENTED, LEFT AS-IS.** **`no_show` is a valid booking status read by `admin.noShowList`, and appears in the random dev seed data, but no application mutation ever sets a real booking to `no_show`.** Same shape as Finding 3 — in the actual running app, this admin report will always come back empty; only the randomized dev seed data can ever populate it. Confirmed by test; see `admin.test.ts`.
14. ✅ **FIXED.** **`admin.classUtilisation` always reports `booked: 0` and `utilisation: 0` for every class, regardless of real bookings — a genuine bug, not a documentation gap.** Root cause: the correlated subquery `where ${bookings.classId} = ${classes.id}` relies on Drizzle to qualify `${classes.id}` with its table name in the generated SQL. Drizzle only does this when the outer query has multiple tables in scope (e.g. via a `.leftJoin(...)`, as `classes.list` has). `classUtilisation`'s outer query selects from `classes` alone with no join, so `${classes.id}` renders as a bare `"id"` in the SQL text. SQLite then resolves that bare identifier to the *closest* table — `bookings`, inside the subquery itself, which also has its own `id` column — so the query actually compares `bookings.class_id = bookings.id` instead of `bookings.class_id = classes.id`. Confirmed by directly inspecting `query.toSQL()` for both the broken and working versions side by side. **Practical impact: the admin Reports page's class utilisation section silently shows 0% for every class in the live app.** This is a strong refactor-fix candidate (well-understood root cause, small fix — either add a no-op join or fully qualify the column manually), not just a documentation item. → Fixed by adding a `leftJoin` that forces Drizzle to fully qualify the subquery's columns, with an in-line comment explaining why the join exists despite its own columns being unused.
15. ✅ **FIXED.** **Waitlist-promotion credit deduction differs between personal and corporate bookings.** Personal (`bookings.ts` `cancel`): always deducts on promotion, flooring at `0` if the promoted member's balance is technically insufficient (`Math.max(0, ...)`) — the promotion always succeeds. Corporate (`corporate-bookings.ts` `cancel`): only deducts *if* `company.creditPoolBalance >= cls.creditCost`; if not, the corporate member is still promoted to `booked` with `creditsUsed` recorded on their booking, but the company's balance is never touched — an unintentional free ride, and an inconsistency with the personal flow. Found while designing the shared booking-core module (see `refactor-decisions.md`); resolved there by picking one consistent policy (floor-at-zero, matching personal) rather than carrying the inconsistency into the unified code. → Unified in `chargeCredits()`, applied identically to both membership and company credit sources.

## 8. Open questions to resolve before/during refactor

- Is the personal/corporate capacity split (Finding 1) intentional business logic (separate pools by design) or an oversight? Affects whether we fix it or just document it.
- Should reschedule (Finding 5) and studio-cancellation (Finding 4) trigger waitlist promotion for consistency with member-initiated cancellation, or are they deliberately different flows?
- Do we wire up the unused notification types (Finding 3), or leave them and document that they're dormant?
