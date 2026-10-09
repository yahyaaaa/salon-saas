@AGENTS.md

# Salon Suite — working notes

Product spec: `BUILD_BRIEF.md`. Setup and architecture: `README.md`.
Build in the phase order the brief lays out.

## Non-negotiables from the brief

1. **Tenant isolation is enforced in Postgres, not in application code.** Every
   new table gets `salon_id`, `enable row level security`, and policies written
   against `public.current_salon_id()` / `public.is_owner()`. Every foreign key
   to another tenant table is composite — `(id, salon_id)`, not `id` — and each
   new parent needs a `unique (id, salon_id)` to be such a target. Do not use
   `force row level security`: see the note in the Phase 1 migration. Add cases
   to `scripts/test-rls.mjs` for each new table and re-run `npm run test:rls`.
2. **Consent form data is sensitive medical information.** It must never appear
   in a cross-tenant query, a log line, an audit `metadata` blob, or a shared
   endpoint. Who may read a consent form — and its signature image — is decided
   in exactly one place, `public.can_access_consent_form()`. Widen visibility by
   editing that function, never by adding a second rule somewhere else.
3. **Appointment slots are protected by the exclusion constraint on
   `appointments`, not by an application check** — never replace it with a
   read-then-write conflict test, which races. Times are stored as instants;
   convert with `@/lib/time`, never by hand.
4. **All money maths is server-side, in Postgres.** `receipts`,
   `receipt_line_items`, `loyalty_transactions` and `payments` have SELECT
   policies and no write policies at all; `create_receipt()`,
   `void_receipt()`, `record_payment()` and `refund_payment()` are the only way
   in. Phase 5 payroll must read `receipt_line_items` the same way — do not
   add a write policy to any of these tables, and do not compute a total in
   TypeScript.
5. **PostgREST sends an explicit NULL for any column omitted from one row of a
   bulk insert or upsert**, which overrides the column DEFAULT and trips NOT
   NULL. Write every column explicitly when upserting (see
   `saveCommissionAction`).
6. **Reports are SECURITY INVOKER and guard themselves with `is_owner()`.**
   Read-only aggregates keep RLS on so the tenant filter is the database's; only
   the owner-only restriction is theirs to enforce. Always bucket by the salon's
   timezone (`at time zone`), never by the server clock.
7. **A zero-row UPDATE is not an error in PostgREST.** When an action's effect
   matters, `.select()` the result and check it -- never treat "no error" as
   success. A missing RLS policy looks exactly like a successful no-op, and did
   for several phases: see migration 20260922000010.
8. **Every tenant table needs its OWN `salon_id references salons on delete
   cascade`.** A path through a parent table is not enough: a salon delete
   cascades to its children in an unspecified order, each as its own statement,
   so a table reachable only two levels down can still be holding a reference
   when a sibling is checked. This has now bitten twice -- migrations
   20260922000006 and 20260922000012.
9. **Pure helpers that a server component needs must NOT live in a "use client"
   module.** The server gets a client reference it cannot call, and the page
   500s at runtime rather than failing the build — see `@/lib/services`.
10. **Line endings are mixed -- detect, never assume.** `test-rls`,
   `test-forms`, `test-money`, `test-audit`, `test-reports` and most of
   `src` are CRLF; `test-time`, `test-signup` and some action modules are
   LF. Multi-line string surgery with the wrong one silently matches
   nothing and reports success. Read with `newline=""`, take the separator
   from the file itself (`"\r\n" if it occurs, else `"\n"`), and prefer
   matching on whole lines.

11. **A page's HTML contains its client components' props.** Every service
   name reaches `/dashboard/calendar` twice: once in the appointment list and
   once inside the booking form's RSC payload. So `body.includes("Facial")` is
   NOT evidence the appointment displays it -- that assertion passes with the
   bug present. Assert against the rendered sentence, with tags and React's
   `<!-- -->` separators stripped (`readable()` in `test-forms`), and prove a
   new display assertion fails by reintroducing the bug once.

12. **Use ON DELETE NO ACTION, not RESTRICT**, for "this row is still in use"
   rules. RESTRICT protects a single-row delete identically but breaks the
   salon-deletion cascade — see migration 20260922000006.

13. **A receipt states its own settlement, and it must still add up.**
   `cash_amount + card_amount + deposit_applied = total` is a check constraint,
   and it is deliberately an equality, not `<=`. Since deposits exist, the till
   collects the BALANCE rather than the total, so the first two terms alone no
   longer reach it -- the fix was to give the row the missing third term, never
   to loosen the constraint into one that would permit an under-settled
   receipt. `deposit_applied` is capped at the total; an over-deposit stays
   visible as a negative appointment balance for the owner to refund.

14. **Service status and payment status are separate axes.** An appointment
   being `completed` says the work happened; what has been paid comes from
   `payments` via `appointment_balance()`. Completing PROMPTS checkout and must
   never require it -- otherwise a therapist cannot record a finished job until
   the customer settles. Never add a "paid" column to `appointments`.

15. **Commission follows the receipt, never the quote.** Payroll reads
   `receipt_line_items.line_total`, which is post-discount, so a discount given
   at the till reduces commission. `appointments.price_at_booking` is an
   estimate and must not reach payroll. Pinned by "Commission follows the
   receipt, not the quote" in `test-money`.

## Conventions

- Data access goes through `@/lib/supabase/server`. `@/lib/supabase/admin`
  bypasses RLS and is reserved for the Auth admin API — do not read or write
  tenant tables with it.
- Guard every page with `requireSession()` / `requireOwner()` / `requireRole()`
  from `@/lib/auth/session`, and every Server Action with `assertRole()`.
  `src/proxy.ts` is a convenience gate, not the security boundary.
- Sensitive actions call `logAudit()` from `@/lib/audit` at the point of the
  action, and add their action string to `AUDIT_ACTIONS` plus the label map in
  `src/app/(dashboard)/dashboard/audit/page.tsx`.
- Mutations are Server Actions in a sibling `actions.ts`; forms are client
  components using `useActionState`.
- Configurable business rules (loyalty earn rate, business hours) live in
  `salon_settings`, never hardcoded.
- Keep `src/lib/types/database.ts` in step with new migrations, or regenerate
  with `npm run db:types`. Table row types must be `type` aliases, not
  `interface` — interfaces lack the implicit index signature that Supabase's
  generics require.

## Checks before calling a phase done

```bash
npm run typecheck && npm run lint && npm run build \n  && npm run test:time && npm run test:money && npm run test:reports \n  && npm run test:rls && npm run test:cascade && npm run test:signup
# and, with the app running (npm run start):
#   npm run test:audit && npm run test:forms
```
