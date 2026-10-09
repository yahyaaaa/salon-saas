# Build Brief: Multi-Tenant Salon & Aesthetic Clinic Management SaaS

## Project Overview
Build a multi-tenant SaaS platform for salons and aesthetic clinics. Each salon signs up, gets its own isolated dashboard, and pays a flat $20/month subscription. Within each salon, there are three roles: **Owner/Admin**, **Staff/Therapist**, and **Receptionist**. The platform handles bookings, POS receipts, a loyalty-points-as-currency system, consent/medical intake, payroll, reporting, and audit logging.

## Tech Stack
- **Frontend/Backend**: Next.js 14+ (App Router), TypeScript
- **Database/Auth**: Supabase (Postgres + Auth + Row Level Security + Storage)
- **Payments (SaaS billing)**: Stripe — flat $20/month subscription per salon
- **Payments (in-salon POS)**: Cash/card logging only for MVP (no live payment gateway needed for customer receipts — record method, not process it)
- **Hosting**: Vercel
- **Styling**: Tailwind CSS

## Multi-Tenancy Model
- Shared database, every table scoped by `salon_id`.
- Enforce isolation via Postgres Row Level Security (RLS) — every query must filter by the authenticated user's `salon_id`.
- No multi-branch support: if an owner has a second location, they create a fully separate salon account/subscription for it. Do not build any branch-linking logic.
- No inventory/consumables tracking in this version — skip stock deduction entirely.

## Roles & Permissions

### 1. Salon Owner / Admin
Full access to everything below, plus:
- Staff management (add/remove staff & receptionist accounts, set roles)
- Payroll (view/calculate staff commission and pay)
- Full reporting/analytics access
- Full audit log access
- Salon settings (services, pricing, loyalty rate, business hours)
- Billing/subscription management (Stripe portal link)

### 2. Staff / Therapist
- View own daily/weekly schedule
- View own appointments and customer consent forms for their bookings
- View own commission/services-performed history (read-only, no payroll editing)
- Cannot see other staff's schedules, payroll, or salon-wide reports

### 3. Receptionist
- Book/manage appointments for any staff member
- Create/search customer profiles
- Generate POS receipts (select services, staff member, apply loyalty redemption, record payment method)
- Collect/attach consent forms per customer
- Cannot access payroll, staff commission figures, or full reporting/analytics

All roles scoped strictly to their own `salon_id` — no cross-salon visibility under any role.

## Core Features

### A. Signup & Onboarding
- Salon owner signs up with salon name, email, password, business type (Salon / Aesthetic Clinic), country/timezone.
- On signup: create `salon` record, create Stripe subscription ($20/month flat, include a free trial period — e.g. 14 days), create owner user linked to that `salon_id`.
- Owner can then invite staff/receptionist via email (Supabase Auth invite flow), assigning role at invite time.

### B. Appointment / Booking Scheduling
- Calendar view (day/week) per staff member.
- Each service has a duration (set in salon settings) — booking a service blocks that staff member's calendar for that duration.
- Appointment states: `booked`, `confirmed`, `completed`, `cancelled`, `no-show`.
- Receptionist can book on behalf of a customer (existing or new) and assign to any available staff member.
- Walk-in flow: allow creating a same-day/immediate appointment marked `walk-in` that skips normal slot conflict checks or force-books into the next open slot.
- Cancellation/no-show must be logged with a reason and timestamp — feeds into reporting.

### C. Customer Profiles & Consent / Medical Intake
- Customer record: name, phone (primary identifier — used for lookup), email (optional), date of birth (optional), notes.
- Consent/medical intake form per customer, versioned per visit if needed:
  - Medical history / allergies (free text)
  - Treatment-specific consent checkboxes (configurable per service — e.g. "I consent to Botox injection risks as explained")
  - Digital signature capture (simple signature-pad component, stored as image/base64 in Supabase Storage)
  - Timestamp and which staff member collected it
- Consent forms must be retrievable per customer, per visit, from both receptionist and the treating staff member's view.
- Store this data with appropriate access restriction — only accessible within that customer's salon (RLS enforced), never exposed cross-tenant.

### D. Services & Pricing (Admin-configured)
- Admin defines services: name, category, price, duration, which staff can perform it, whether a specific consent form template applies.
- Deals/discounts: admin can create a deal (e.g. "20% off Service X this month" or a bundle price) with a start/end date — receptionist applies at checkout.

### E. POS / Receipt Generation
- Receptionist flow: select customer (search by phone/name or create new) → select staff member → select service(s)/deal → system calculates subtotal.
- Apply loyalty point redemption (see below) as a discount against the bill.
- Record payment method (cash / card / split — just log the split amounts, no gateway processing needed).
- Generate receipt: itemized services, staff member, discounts applied, loyalty points earned this visit, loyalty points redeemed this visit, final total, timestamp, receptionist who issued it.
- Receipts must be voidable/refundable by admin only, with a required reason — original receipt stays in the record, marked `voided`, not deleted (audit trail).
- Receipt should be shareable — generate a printable/PDF view at minimum; SMS/WhatsApp send can be a stretch goal, not MVP-blocking.

### F. Loyalty Points (Points = Real Money Value)
- On every completed receipt, customer earns points equal to **5% of the bill total**, stored as a **currency value**, not an abstract point count (e.g. $50 bill → $2.50 credited to their loyalty balance).
- Customer's loyalty balance is visible in their profile at all times.
- At checkout, receptionist can apply up to the customer's full available balance as a direct discount against the new bill total (cannot redeem more than the bill amount or more than the available balance).
- Points earned on a bill are only available for redemption on future visits (not usable within the same transaction they were earned).
- No tiers, no bonus multipliers, no expiry — flat 5% earn rate, dollar-for-dollar redemption. (Make the 5% rate a configurable field per salon in settings, even though default is 5%, so it's not hardcoded.)
- Every earn/redeem event must be logged in a `loyalty_transactions` table (customer_id, receipt_id, type: earn/redeem, amount, resulting_balance, timestamp) — this feeds both the customer balance and the audit log.

### G. Staff Payroll
- Each completed service on a receipt is attributed to the staff member who performed it.
- Admin sets a commission rate per staff member (flat % or fixed amount per service — support at least flat % of service value for MVP).
- Payroll view (admin only): select date range → see per-staff totals (services performed, revenue generated, commission owed) → mark as "paid" with a timestamp (no actual bank transfer integration needed, just a ledger/status).
- Payroll records are historical — don't allow editing a period once marked paid, only viewing.

### H. Reporting & Analytics (Admin only)
- Revenue over time (daily/weekly/monthly, filterable by date range)
- Revenue by service / by staff member
- Customer retention: repeat-visit rate, new vs returning customers per period
- Appointment stats: booked vs completed vs no-show vs cancelled, by staff
- Loyalty program cost: total points issued vs redeemed (in $) per period — this is a real liability figure the owner needs to see
- Peak hours/days (based on appointment timestamps)

### I. Audit Logging
- Log every sensitive action with: actor (user_id + role), action type, target entity, timestamp, salon_id.
- Minimum actions to log: receipt created, receipt voided/refunded, appointment cancelled/no-show marked, staff account added/removed/role changed, payroll marked paid, consent form created, loyalty redemption applied, salon settings changed (services/prices/loyalty rate).
- Audit log viewable by admin only, filterable by date/actor/action type. Read-only, never editable or deletable from the UI.

### J. Billing (Platform → Salon Owner)
- Flat $20/month per salon via Stripe Subscriptions.
- Include a trial period (e.g., 14 days) before first charge.
- Simple billing status on admin dashboard: active / trialing / past_due / cancelled, with a link to Stripe's customer portal for managing payment method / cancellation.
- If subscription lapses (`past_due` beyond grace period or `cancelled`), lock the dashboard to read-only or block login except to reactivate billing — your call on exact UX, but access must be gated by subscription status.

## Database Schema — Starting Point (adjust as needed)
Core tables: `salons`, `users` (with `role` + `salon_id`), `customers`, `services`, `deals`, `appointments`, `consent_forms`, `receipts`, `receipt_line_items`, `loyalty_transactions`, `payroll_periods`, `payroll_entries`, `audit_logs`, `salon_settings`.

Every table except `salons` itself must have a `salon_id` foreign key, and RLS policies must enforce that a user can only read/write rows matching their own `salon_id` (admins/staff/receptionists alike — no exceptions).

## Build Order (suggested phases)
1. Auth + multi-tenant scaffolding (signup, RLS, roles, invites)
2. Services/settings + customer profiles + consent forms
3. Appointment/booking calendar
4. POS/receipt generation + loyalty earn/redeem logic
5. Payroll
6. Reporting/analytics
7. Audit logging (thread this through as each feature above is built, not bolted on at the end)
8. Stripe subscription billing + access gating

## Non-Negotiables
- Tenant isolation (RLS) must be tested explicitly: create two salons, verify neither can see the other's customers, receipts, staff, or reports under any role.
- Consent form data is sensitive medical information — do not expose it in any cross-tenant query, log, or shared endpoint.
- All loyalty and payroll math must be server-side (Supabase functions or API routes), never trust client-submitted totals for money calculations.
