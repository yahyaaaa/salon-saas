# Salon Suite

Multi-tenant SaaS for salons and aesthetic clinics: bookings, POS receipts,
loyalty-as-currency, consent/medical intake, payroll, reporting and audit
logging. One salon per account, $20/month flat.

Full product specification: [BUILD_BRIEF.md](BUILD_BRIEF.md).

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Database / Auth / Storage | Supabase (Postgres + Auth + RLS) |
| Styling | Tailwind CSS v4 |
| Validation | Zod |
| Hosting | Vercel |

## Setup

### 1. Create a Supabase project

Create one at [supabase.com/dashboard](https://supabase.com/dashboard), then
copy the credentials:

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
`SUPABASE_SECRET_KEY` from **Project Settings → API Keys**.

> `SUPABASE_SECRET_KEY` bypasses Row Level Security. It is server-only and is
> used for exactly one thing: sending staff invitations through the Auth admin
> API. Never expose it to the browser.

### 2. Apply the schema

Either link the CLI and push:

```bash
npx supabase login
npm run db:link          # pick your project
npm run db:push          # applies supabase/migrations/*
```

...or paste `supabase/migrations/20260922000001_phase1_auth_tenancy.sql` into
the SQL Editor in the Supabase dashboard and run it.

### 3. Configure Auth redirect URLs

In **Authentication → URL Configuration** add these to *Redirect URLs*:

```
http://localhost:3000/auth/confirm
http://localhost:3000/**
```

Add your production origin the same way when you deploy.

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>, create a salon, and you land in the dashboard as
its owner.

## Verifying tenant isolation

The brief makes this non-negotiable, so it is a runnable test rather than a
claim. It creates two complete salons plus staff and receptionists, then tries
every cross-tenant read and write it can, as each role, using the public
publishable key — the same access a hostile client would have.

```bash
npm run test:rls      # two salons, every role, every cross-tenant read and write
npm run test:signup   # the signup and invite flows build a tenant correctly
npm run test:time     # salon-local time conversions (no database needed)
npm run test:money    # receipt, loyalty and payroll arithmetic
npm run test:reports  # report aggregation, in a UTC+5 salon
npm run test:audit    # every audited action, driven through the running app
npm run test:forms    # rejected forms keep what was typed; country/currency links
```

They clean up the accounts they create. Point them at a development project.

`test:audit` is different from the rest: it drives the **running application**
over HTTP -- real login, real Server Actions, real session cookies -- because
most audit entries are written by `logAudit()` inside a Server Action, and a
test that spoke to Postgres directly would be checking its own arithmetic. So
start the app first:

```bash
npm run build && npm run start          # one terminal
npm run test:audit && npm run test:forms  # another
```

If `test:audit` reports that the server does not recognise an action, the build
manifest on disk has drifted from the running server. Rebuild from clean
(`rm -rf .next && npm run build`) and restart.

`test:signup` needs **Confirm email** switched off under *Authentication -> Sign
In / Providers -> Email*; otherwise every signup tries to send mail and trips
Supabase's built-in SMTP rate limit. The script says so rather than failing
obscurely.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | Route typegen + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test:rls` | Tenant isolation test suite |
| `npm run test:signup` | Signup and invite flow test |
| `npm run test:time` | Salon-local time conversion test |
| `npm run test:money` | Receipt, loyalty and payroll arithmetic |
| `npm run test:reports` | Report aggregation test |
| `npm run test:audit` | Audit log verification (needs the app running) |
| `npm run test:forms` | Form behaviour and locale links (needs the app running) |
| `npm run db:push` | Apply migrations to the linked project |
| `npm run db:types` | Regenerate database types from the live schema |

## Architecture

### Tenancy

Shared database, one `salon_id` on every table but `salons` itself. Isolation is
enforced by Postgres Row Level Security, not by application code — a request
that bypasses the UI entirely still cannot reach another salon's rows.

Policies resolve the caller's tenant through three `SECURITY DEFINER` helpers:

```sql
public.current_salon_id()   -- NULL for anonymous and deactivated users
public.current_app_role()
public.is_owner()
```

They read `profiles` with RLS bypassed, which is what stops a policy on
`profiles` recursing into itself. Because `current_salon_id()` returns NULL for
a deactivated user, deactivating someone revokes their access everywhere at
once, with no extra check to remember in each feature.

### Which Supabase client to use

| File | Key | RLS | Use for |
| --- | --- | --- | --- |
| `lib/supabase/server.ts` | publishable | enforced | Essentially everything: Server Components, Server Actions, Route Handlers |
| `lib/supabase/client.ts` | publishable | enforced | Browser-side reads |
| `lib/supabase/admin.ts` | secret | **bypassed** | Auth admin API only (invites). Never tenant data. |

### Signup and invites

Both paths run through one `auth.users` insert trigger, `handle_new_user`:

- **Owner signup** — `salon_name` and friends ride along in the auth metadata.
  The trigger creates the salon, its settings row, the owner profile and the
  first audit entry inside the same transaction as the auth user. If it raises,
  the signup fails, so an auth user without a tenant cannot exist.
- **Invited member** — the owner's action writes an `invitations` row *before*
  the Auth invite is sent. The trigger finds that row and assigns the salon and
  role from it. The invitee never supplies either, so neither can be forged.

### Composite foreign keys

From Phase 2 onward, every foreign key between tenant tables references
`(id, salon_id)` rather than `id` alone, so each parent carries a
`unique (id, salon_id)` purely as an FK target. Attaching a row to a parent in
another salon is then rejected by the database itself — not by RLS, and not by
application code. It is what makes "a deal that includes another salon's
service" or "a consent form attached to another salon's customer" structurally
impossible rather than merely unlikely.

### Consent records

Consent forms are sensitive medical information and are treated differently
from everything else:

- **Visibility is narrower than the tenant.** Owners and receptionists see the
  salon's records; a therapist sees only forms they collected, plus any attached
  to an appointment they are treating. That rule lives in one function,
  `public.can_access_consent_form()`, used by the table policies AND by the
  Storage policies on both the signature images and the attachments -- so they
  cannot drift apart.
- **Signed records are immutable.** A correction means collecting a new form.
  Sealing a draft is the single permitted transition, and only by the person who
  collected it.
- **Attachments lock on signing.** A consent record can carry supporting
  documents -- a lab result, a referral, a reference photo (PDF, JPG, PNG or
  WebP, up to 10 MB, five per form). They can be attached only while the form is
  still an unsigned draft. A signature attests to what the customer was shown
  and agreed to at that moment, and a record whose contents can grow afterwards
  does not support that claim. A document that arrives later belongs on a new
  consent record, for the same reason a correction does.
- **Only unsigned drafts can be deleted**, and only by the person who started
  them. That is what lets the intake action roll back cleanly if an upload
  fails.
- **The wording is snapshotted.** `consent_form_responses.label` is a copy of
  the template statement, not a reference to it.
- **Audit metadata never carries medical detail** -- the entries record which
  customer and which service, and a count of attachments, never the history,
  the allergies, the statements, or the file names (which can themselves be
  revealing).

### Signature storage

Signatures live in the private `consent-signatures` bucket, laid out as
`<salon_id>/<customer_id>/<form_id>.png` so the policies can authorise on the
path prefix. Reads go through the same `can_access_consent_form()` check, so a
therapist who did not collect a form cannot fetch its image even holding the
exact object path. The app serves them as 60-second signed URLs minted through
the RLS-bound client, and records each view in the audit log.

### Booking

Two things about the diary are worth knowing before changing it.

**Double-booking is prevented by the database, not by a check in the action.**
`appointments` carries a GiST exclusion constraint over
`(staff_id, tstzrange(starts_at, ends_at))`. A read-then-write check would race:
two receptionists booking the same slot in the same moment would both see it
free and both succeed. Walk-ins are excluded from the constraint on purpose —
the brief asks for them to skip conflict checks, so they neither cause nor
suffer a clash. Cancelled and no-show appointments release their slot.

**Times are stored as instants and entered as salon-local wall clock.**
`src/lib/time.ts` converts between the two using the salon's IANA timezone, via
`Intl` rather than a date library. The conversion takes two passes because a
zone's offset depends on the very instant being resolved — a single pass lands
on the wrong side of a daylight-saving boundary. `npm run test:time` pins that
down, along with midnight and the dateline.

Durations and prices are never taken from the form: the booking action reads
them from the service and snapshots the price onto the appointment, so Phase 4
bills what was quoted rather than today's price list.

### Money

`receipts`, `receipt_line_items` and `loyalty_transactions` have SELECT
policies and **nothing else** — no INSERT, UPDATE or DELETE policy exists on
any of them. The only way to write a receipt or move a loyalty balance is
`create_receipt()` and `void_receipt()`, two SECURITY DEFINER functions that
check the caller's role themselves and re-derive every figure from the
catalogue.

So the till submits *what was done* — services, quantities, who performed them
— and never a price, a discount or a total. A receptionist holding the
publishable key and a REST client cannot mint loyalty, alter a total, or
hand-write a line. The figures the POS screen shows are an estimate for the
person at the desk; the server's calculation is what lands on the receipt.

Other decisions worth knowing:

- **Loyalty is earned on what was actually paid**, i.e. after discounts and
  after any redemption — so spending a balance cannot itself mint a new one.
  The brief says "5% of the bill total" without settling that case; if you want
  it earned pre-redemption instead, it is one line in `create_receipt()`.
- **The balance is the sum of the ledger**, not a cached column, because it is a
  real liability the owner reports on and a cache is one bug from disagreeing
  with the entries that justify it.
- **Checkout serialises per customer** on an advisory lock, so two tills cannot
  both spend the same balance, and per salon, so receipt numbering is gapless.
- **Voiding compensates, it does not erase.** The receipt stays exactly as
  issued with `status = 'voided'`, and the loyalty it moved is reversed with new
  ledger entries. If the customer already spent what the receipt granted, the
  balance can go negative — that is a real debt, left visible, and redemption is
  floored at zero so it cannot be spent.
- **Rounding happens once, at the end**, on Postgres `numeric` — exact decimal
  arithmetic, no floats anywhere in the path.

### Deleting a salon

Every "you cannot delete a customer who has a medical record" rule is expressed
with ON DELETE NO ACTION, not RESTRICT. Both refuse a single-row delete
identically; they differ only when parent and child go in the same statement,
which is what deleting a salon does. RESTRICT made a salon undeletable
entirely — see `20260922000006_phase4_deletable_salon.sql`.

### Payroll

Commission is derived from `receipt_line_items` — the rows the POS already
wrote, carrying who performed each service, what it netted after discount, and
when. Nothing is re-entered by hand, and `generate_payroll_period()` is the
only way a period comes into existence.

- **Commission rates live in `staff_compensation`, not on `profiles`.** Every
  member of a salon can read `profiles` (the front desk needs the staff list),
  and what a colleague is paid is not theirs to see. An owner sees the salon's
  rates; a therapist sees only their own; a receptionist sees none.
- **Voided receipts earn no commission**, and a period is bucketed by the
  salon's own timezone — an 11pm receipt on the 31st belongs to the month the
  salon was working.
- **Periods cannot overlap.** An exclusion constraint on `(salon_id, daterange)`
  refuses it, so the same work can never be paid twice.
- **A paid period is history.** Guard triggers reject every change to it and to
  its entries; a draft generated for the wrong dates can be discarded and redone,
  a paid one cannot.
- **Rates are snapshotted onto each entry**, so an old payslip still explains
  itself after the owner changes someone's commission.

A therapist's own view lives at `/dashboard/earnings` — read-only, and scoped by
RLS rather than by the queries on that page.

### Reporting

The report functions are SECURITY INVOKER, unlike the money and payroll ones.
They only read, so leaving RLS switched on makes the tenant filter the
database's job rather than something each aggregate has to remember — the
failure mode being one forgotten `where salon_id =` quietly folding another
salon's revenue into yours. What the policies do *not* express is that reports
are the owner's alone (a receptionist reads receipts legitimately, for the
till), so each function checks `is_owner()` itself.

Everything buckets in the salon's own timezone, which is load-bearing: a sale
at 00:30 local is the previous day in UTC, and "peak hours" means the hours
staff were actually standing up. `npm run test:reports` runs against a UTC+5
salon for exactly this reason.

Definitions worth knowing, because these words mean different things elsewhere:

- **Revenue** is what was actually taken — after discounts and after loyalty
  redemption. Voided receipts are excluded everywhere.
- **New** customer: their first ever paid visit falls inside the period.
  **Returning**: they visited in the period and had visited before it started.
  **Repeat rate** is returning ÷ total.
- **Outstanding loyalty liability** sums only *positive* balances, across the
  whole programme rather than the period. A customer left owing the salon after
  a void is a debt, not something to net off against what other customers are
  owed.
- **Peak times** exclude cancelled appointments but keep no-shows — the slot was
  held and the staff member was waiting.

### Audit logging

`lib/audit.ts` is threaded through features as they are built, per the brief,
rather than bolted on at the end. Every action string it declares is exercised
by `npm run test:audit`, which drives the real application; an action that is
declared but never fires is a failure there, not a footnote.

The entries written by the POS and payroll functions are inserted **inside those
Postgres functions**, so they cannot be bypassed by anything that reaches the
database another way.

`audit_logs` is append-only, in two layers:

- **RLS** gives owners SELECT and members INSERT, with the insert policy pinning
  `salon_id` to the caller's salon and `actor_id` to the caller -- so an entry
  cannot be forged against another tenant or attributed to someone else.
- **A trigger** refuses every UPDATE and DELETE regardless of who is asking.
  RLS alone does not cover this: the `service_role` key bypasses RLS entirely,
  so "no UPDATE policy" stops ordinary callers but not the server's own key.
  For a log whose whole value is being trustworthy after the fact, that gap
  mattered. The one exception is a salon being deleted, which takes its own
  records with it.

Audit metadata deliberately excludes sensitive content: consent entries record
which customer and which service, never the medical history, the allergies, or
the statements agreed to. `test:audit` asserts that.

## Build progress

- [x] **Phase 1** — Auth + multi-tenant scaffolding (signup, RLS, roles, invites)
- [x] **Phase 2** — Services/settings + customer profiles + consent forms
- [x] **Phase 3** — Appointment/booking calendar
- [x] **Phase 4** — POS/receipts + loyalty earn/redeem
- [x] **Phase 5** — Payroll
- [x] **Phase 6** — Reporting/analytics
- [x] **Phase 7** — Audit logging (threaded through each phase above)
- [ ] **Phase 8** — Stripe subscription billing + access gating
