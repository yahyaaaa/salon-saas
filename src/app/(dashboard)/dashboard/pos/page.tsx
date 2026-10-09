import Link from "next/link";
import type { Metadata } from "next";

import { Till, type CheckoutPrefill } from "./till";
import { requireModule } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/format";
import {
  addDays,
  daysInRange,
  endOfMonth,
  formatInstantInSalon,
  salonTimeToInstant,
  salonToday,
  startOfMonth,
  startOfWeek,
} from "@/lib/time";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  PageHeader,
  Select,
} from "@/components/ui";
import type {
  AppointmentBalance,
  AppointmentRow,
  AppointmentServiceRow,
  CustomerRow,
  DealRow,
  DealServiceRow,
  ReceiptRow,
  ServiceRow,
  TeamMemberRow,
} from "@/lib/types/database";

export const metadata: Metadata = { title: "POS" };

/** Same reasoning as the calendar's agenda: a longer span is a mistyped year. */
const MAX_RANGE_DAYS = 366;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asDate(value: unknown, fallback: string): string {
  return typeof value === "string" && ISO_DATE.test(value) ? value : fallback;
}

export default async function PosPage({ searchParams }: PageProps<"/dashboard/pos">) {
  const session = await requireModule("pos");
  const supabase = await createClient();
  const currency = session.salon.currency;
  const timeZone = session.salon.timezone;

  const params = await searchParams;
  const today = salonToday(timeZone);

  // The till defaults to what it is for -- today's takings. Everything else is
  // a deliberate look back.
  let from = asDate(params.from, today);
  let to = asDate(params.to, today);
  if (to < from) [from, to] = [to, from];
  let rangeTooLong = false;
  if (daysInRange(from, to) > MAX_RANGE_DAYS) {
    to = addDays(from, MAX_RANGE_DAYS - 1);
    rangeTooLong = true;
  }

  const status = params.status === "issued" || params.status === "voided" ? params.status : "all";

  /*
   * The range is a pair of salon-local calendar days, so it is converted to
   * instants here rather than compared as dates. A sale at 11pm on the 30th
   * belongs to the day the salon was working, not to whatever UTC says --
   * the same rule the Phase 6 reports and payroll use.
   */
  const rangeStartsAt = salonTimeToInstant(from, "00:00", timeZone).toISOString();
  const rangeEndsAt = salonTimeToInstant(addDays(to, 1), "00:00", timeZone).toISOString();

  let receiptQuery = supabase
    .from("receipts")
    .select("*")
    .gte("created_at", rangeStartsAt)
    .lt("created_at", rangeEndsAt)
    .order("created_at", { ascending: false })
    .limit(500);

  if (status !== "all") receiptQuery = receiptQuery.eq("status", status);

  const [
    { data: customers },
    { data: services },
    { data: team },
    { data: deals },
    { data: dealServices },
    { data: receipts },
  ] = await Promise.all([
    supabase.from("customers").select("*").order("full_name").limit(500),
    supabase.from("services").select("*").eq("is_active", true).order("category").order("name"),
    // The roster: who may be named against a line as having performed it.
    supabase.from("team_members").select("*").eq("is_active", true).order("full_name"),
    // Only deals actually running today can be applied.
    supabase
      .from("deals")
      .select("*")
      .eq("is_active", true)
      .lte("starts_on", today)
      .gte("ends_on", today)
      .order("name"),
    supabase.from("deal_services").select("*"),
    receiptQuery,
  ]);

  const therapists = (team ?? []) as TeamMemberRow[];

  const servicesByDeal: Record<string, string[]> = {};
  for (const link of (dealServices ?? []) as DealServiceRow[]) {
    (servicesByDeal[link.deal_id] ??= []).push(link.service_id);
  }

  const customerById = new Map<string, CustomerRow>();
  for (const c of (customers ?? []) as CustomerRow[]) customerById.set(c.id, c);

  /*
   * Checking a booking out. The diary sends the visit here rather than the
   * front desk re-entering it, and the deposit already taken comes with it so
   * the till asks for the balance.
   *
   * An already-billed visit is deliberately NOT prefilled: create_receipt()
   * would refuse it, and an empty till with an explanation beats a filled one
   * that cannot be submitted.
   */
  const wantedAppointment =
    typeof params.appointment === "string" && params.appointment ? params.appointment : null;

  let prefill: CheckoutPrefill | undefined;
  let prefillProblem: string | null = null;

  if (wantedAppointment) {
    const [{ data: appointment }, { data: bookedLines }, { data: balanceRows }] =
      await Promise.all([
        supabase.from("appointments").select("*").eq("id", wantedAppointment).maybeSingle(),
        supabase
          .from("appointment_services")
          .select("*")
          .eq("appointment_id", wantedAppointment)
          .order("sort_order"),
        supabase.rpc("appointment_balance", { p_appointment_id: wantedAppointment }),
      ]);

    const appt = appointment as AppointmentRow | null;
    const balance = ((balanceRows ?? []) as AppointmentBalance[])[0];

    /*
     * Fetched by id, NOT read out of `customerById`. That map is capped at 500
     * rows for the search box, so in a salon with more customers than that the
     * booking's customer can simply be missing from it -- and a customer
     * created during booking is new enough to be anywhere in the ordering.
     */
    const { data: visitCustomer } = appt
      ? await supabase.from("customers").select("*").eq("id", appt.customer_id).maybeSingle()
      : { data: null };
    const visitor = visitCustomer as CustomerRow | null;

    if (!appt) {
      prefillProblem = "That appointment could not be found.";
    } else if (balance?.has_receipt) {
      prefillProblem = "That appointment has already been billed.";
    } else if (appt.status === "cancelled" || appt.status === "no_show") {
      prefillProblem = `That appointment was ${appt.status.replace("_", "-")}, so there is nothing to bill.`;
    } else {
      prefill = {
        appointmentId: appt.id,
        customerId: appt.customer_id,
        customerName: visitor?.full_name ?? "the customer",
        customerLabel: visitor
          ? `${visitor.full_name}${visitor.phone ? ` — ${visitor.phone}` : ""}`
          : "Customer on this booking",
        deposit: Number(balance?.amount_paid ?? 0),
        lines: ((bookedLines ?? []) as AppointmentServiceRow[]).map((line) => ({
          serviceId: line.service_id,
          staffId: appt.staff_id,
          quantity: line.quantity,
        })),
      };
    }
  }

  const rows = (receipts ?? []) as ReceiptRow[];
  const issued = rows.filter((r) => r.status === "issued");
  const voided = rows.filter((r) => r.status === "voided");
  // Voided money was given back, so it is not takings. Counted separately so
  // the owner can see how much was reversed.
  const takings = issued.reduce((sum, r) => sum + Number(r.total), 0);
  const reversed = voided.reduce((sum, r) => sum + Number(r.total), 0);

  const rangeLabel =
    from === to
      ? from === today
        ? "today"
        : from
      : `${from} to ${to}`;

  return (
    <>
      <PageHeader
        title="Point of sale"
        description="Prices, discounts, loyalty and the total are all calculated on the server — the till only says what was done."
      />

      {prefillProblem ? <Alert tone="warning">{prefillProblem}</Alert> : null}

      {/*
        Keyed on the visit so moving from one booking's checkout straight to
        another remounts the till. The basket and the chosen customer are
        seeded once in useState, and a client-side navigation within the same
        route reconciles rather than remounts -- the second booking would
        otherwise inherit the first one's basket. Same defect as the reports
        date boxes.
      */}
      <Till
        key={prefill?.appointmentId ?? "walk-in"}
        services={(services ?? []) as ServiceRow[]}
        therapists={therapists.map((t) => ({ id: t.id, name: t.full_name }))}
        deals={(deals ?? []) as DealRow[]}
        servicesByDeal={servicesByDeal}
        currency={currency}
        prefill={prefill}
      />

      <Card>
        <CardHeader
          title="Receipts"
          description={`Showing ${rangeLabel}. Open a receipt to print it${
            session.profile.role === "owner" ? ", or to void it with a reason" : ""
          }.`}
        />

        <div className="border-b border-ink-200 px-5 py-3">
          {/*
            A plain GET form, so a particular day's takings are a linkable URL
            and survive a refresh.
          */}
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <label htmlFor="pos-from" className="mb-1.5 block text-xs font-medium text-ink-600">
                From
              </label>
              <Input id="pos-from" name="from" type="date" defaultValue={from} />
            </div>
            <div className="w-44">
              <label htmlFor="pos-to" className="mb-1.5 block text-xs font-medium text-ink-600">
                To
              </label>
              <Input id="pos-to" name="to" type="date" defaultValue={to} />
            </div>
            <div className="w-40">
              <label htmlFor="pos-status" className="mb-1.5 block text-xs font-medium text-ink-600">
                Status
              </label>
              <Select id="pos-status" name="status" defaultValue={status}>
                <option value="all">All</option>
                <option value="issued">Issued only</option>
                <option value="voided">Voided only</option>
              </Select>
            </div>
            <Button type="submit" variant="secondary">
              Show
            </Button>

            <div className="flex flex-wrap items-center gap-1 text-xs">
              <span className="text-ink-400">Quick:</span>
              <QuickRange href={posHref(today, today, status)}>Today</QuickRange>
              <QuickRange href={posHref(addDays(today, -1), addDays(today, -1), status)}>
                Yesterday
              </QuickRange>
              <QuickRange href={posHref(startOfWeek(today), addDays(startOfWeek(today), 6), status)}>
                This week
              </QuickRange>
              <QuickRange href={posHref(startOfMonth(today), endOfMonth(today), status)}>
                This month
              </QuickRange>
              <QuickRange href={posHref(addDays(today, -29), today, status)}>Last 30 days</QuickRange>
            </div>
          </form>

          {rangeTooLong ? (
            <p className="mt-2 text-xs text-amber-700">
              That range was longer than a year, so it has been trimmed to {MAX_RANGE_DAYS} days.
            </p>
          ) : null}
        </div>

        {/* What the range came to. */}
        <dl className="grid gap-px border-b border-ink-200 bg-ink-200 sm:grid-cols-3">
          <Stat label="Receipts issued" value={String(issued.length)} />
          <Stat label="Takings" value={formatMoney(takings, currency)} />
          <Stat
            label="Voided"
            value={
              voided.length === 0
                ? "None"
                : `${voided.length} · ${formatMoney(reversed, currency)}`
            }
            tone={voided.length > 0 ? "danger" : "normal"}
          />
        </dl>

        {rows.length === 0 ? (
          <EmptyState>No receipts in this range.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200">
            {rows.map((receipt) => (
              <li key={receipt.id}>
                <Link
                  href={`/dashboard/pos/${receipt.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 hover:bg-ink-50"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                      <span className="tabular-nums">#{receipt.receipt_number}</span>
                      <span className="truncate">
                        {customerById.get(receipt.customer_id)?.full_name ?? "Customer"}
                      </span>
                      {receipt.status === "voided" ? <Badge tone="danger">Voided</Badge> : null}
                    </p>
                    <p className="text-xs text-ink-500">
                      {formatInstantInSalon(receipt.created_at, timeZone)}
                    </p>
                  </div>
                  <span
                    className={
                      receipt.status === "voided"
                        ? "text-sm tabular-nums text-ink-400 line-through"
                        : "text-sm font-medium tabular-nums text-ink-900"
                    }
                  >
                    {formatMoney(receipt.total, currency)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function posHref(from: string, to: string, status: string): string {
  return `/dashboard/pos?from=${from}&to=${to}&status=${status}`;
}

function QuickRange({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-ink-200 px-2 py-1 font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900"
    >
      {children}
    </Link>
  );
}

function Stat({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: string;
  tone?: "normal" | "danger";
}) {
  return (
    <div className="bg-white px-5 py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd
        className={
          tone === "danger"
            ? "mt-0.5 text-base font-semibold tabular-nums text-red-700"
            : "mt-0.5 text-base font-semibold tabular-nums text-ink-900"
        }
      >
        {value}
      </dd>
    </div>
  );
}
