import Link from "next/link";
import type { Metadata } from "next";

import { RevenueChart } from "./revenue-chart";
import { PeakHeatmap } from "./peak-heatmap";
import { requireModule } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatMoney } from "@/lib/format";
import { addDays, salonToday } from "@/lib/time";
import { Alert, Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import type {
  AppointmentStats,
  LoyaltyCost,
  PeakTime,
  ReportGranularity,
  RetentionSummary,
  RevenueBucket,
  RevenueByService,
  RevenueByStaff,
} from "@/lib/types/database";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: PageProps<"/dashboard/reports">) {
  const session = await requireModule("reports");
  const supabase = await createClient();
  const currency = session.salon.currency;
  const timeZone = session.salon.timezone;

  const params = await searchParams;
  const isDate = (v: unknown): v is string =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

  const to = isDate(params.to) ? params.to : salonToday(timeZone);
  const from = isDate(params.from) ? params.from : addDays(to, -29);
  const granularity: ReportGranularity =
    params.granularity === "week" || params.granularity === "month"
      ? params.granularity
      : "day";

  const args = { p_from: from, p_to: to };

  const [revenue, byService, byStaff, retention, appointments, loyalty, peaks] =
    await Promise.all([
      supabase.rpc("report_revenue_over_time", { ...args, p_granularity: granularity }),
      supabase.rpc("report_revenue_by_service", args),
      supabase.rpc("report_revenue_by_staff", args),
      supabase.rpc("report_customer_retention", args),
      supabase.rpc("report_appointment_stats", args),
      supabase.rpc("report_loyalty_cost", args),
      supabase.rpc("report_peak_times", args),
    ]);

  const buckets = (revenue.data ?? []) as RevenueBucket[];
  const services = (byService.data ?? []) as RevenueByService[];
  const staff = (byStaff.data ?? []) as RevenueByStaff[];
  const retentionRow = ((retention.data ?? []) as RetentionSummary[])[0];
  const appointmentRows = (appointments.data ?? []) as AppointmentStats[];
  const loyaltyRow = ((loyalty.data ?? []) as LoyaltyCost[])[0];
  const peakRows = (peaks.data ?? []) as PeakTime[];

  const firstError = [revenue, byService, byStaff, retention, appointments, loyalty, peaks].find(
    (r) => r.error,
  )?.error;

  const totalRevenue = buckets.reduce((sum, b) => sum + Number(b.revenue), 0);
  const totalReceipts = buckets.reduce((sum, b) => sum + Number(b.receipt_count), 0);
  const totalDiscounts = buckets.reduce((sum, b) => sum + Number(b.discounts), 0);
  const averageSale = totalReceipts === 0 ? 0 : totalRevenue / totalReceipts;

  const appointmentTotals = appointmentRows.reduce(
    (acc, row) => ({
      completed: acc.completed + Number(row.completed),
      cancelled: acc.cancelled + Number(row.cancelled),
      noShow: acc.noShow + Number(row.no_show),
      total: acc.total + Number(row.total),
    }),
    { completed: 0, cancelled: 0, noShow: 0, total: 0 },
  );

  return (
    <>
      <PageHeader
        title="Reports"
        description={`${formatDate(from)} to ${formatDate(to)} · counted in ${timeZone}`}
      />

      <Card>
        <CardHeader title="Period" />
        <form className="flex flex-wrap items-end gap-3 px-5 py-4">
          <DateField label="From" name="from" value={from} />
          <DateField label="To" name="to" value={to} />
          <div>
            <label
              htmlFor="granularity"
              className="mb-1.5 block text-sm font-medium text-ink-700"
            >
              Group by
            </label>
            <select
              key={granularity}
              id="granularity"
              name="granularity"
              defaultValue={granularity}
              className="block rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </div>
          <button
            type="submit"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Apply
          </button>
          <div className="flex items-center gap-1 text-sm">
            <Preset label="7 days" days={6} granularity="day" timeZone={timeZone} from={from} to={to} />
            <Preset label="30 days" days={29} granularity="day" timeZone={timeZone} from={from} to={to} />
            <Preset
              label="12 months"
              days={364}
              granularity="month"
              timeZone={timeZone}
              from={from}
              to={to}
            />
          </div>
        </form>
      </Card>

      {firstError ? (
        <Alert tone="error">
          A report could not be loaded: {firstError.message.replace(/^.*?:\s*/, "")}
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Revenue" value={formatMoney(totalRevenue, currency)} />
        <Stat label="Receipts" value={String(totalReceipts)} />
        <Stat label="Average sale" value={formatMoney(averageSale, currency)} />
        <Stat label="Discounts given" value={formatMoney(totalDiscounts, currency)} />
      </div>

      <Card>
        <CardHeader
          title="Revenue over time"
          description="Voided receipts are excluded. Revenue is what was actually taken, after discounts and loyalty redemption."
        />
        {buckets.length === 0 ? (
          <EmptyState>No sales in this period.</EmptyState>
        ) : (
          <div className="px-5 py-4">
            <RevenueChart buckets={buckets} currency={currency} granularity={granularity} />
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Loyalty programme cost"
          description="Credit issued is money promised. The outstanding balance is what the salon still owes its customers — across the whole programme, not just this period."
        />
        {!loyaltyRow ? (
          <EmptyState>No loyalty activity.</EmptyState>
        ) : (
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-4">
            <Figure label="Issued this period" value={formatMoney(loyaltyRow.issued, currency)} />
            <Figure label="Redeemed this period" value={formatMoney(loyaltyRow.redeemed, currency)} />
            <Figure
              label="Net movement"
              value={formatMoney(loyaltyRow.net_change, currency)}
              hint={
                Number(loyaltyRow.net_change) >= 0
                  ? "The liability grew"
                  : "Customers spent more than they earned"
              }
            />
            <Figure
              label="Outstanding liability"
              value={formatMoney(loyaltyRow.outstanding_balance, currency)}
              hint={`held by ${loyaltyRow.customers_with_balance} customer${
                Number(loyaltyRow.customers_with_balance) === 1 ? "" : "s"
              }`}
              emphasis
            />
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Revenue by service" />
          {services.length === 0 ? (
            <EmptyState>Nothing sold in this period.</EmptyState>
          ) : (
            <BarList
              rows={services.map((row) => ({
                key: row.service_name,
                label: row.service_name,
                sub: `${row.quantity} sold`,
                value: Number(row.revenue),
              }))}
              currency={currency}
            />
          )}
        </Card>

        <Card>
          <CardHeader title="Revenue by team member" />
          {staff.length === 0 ? (
            <EmptyState>Nothing sold in this period.</EmptyState>
          ) : (
            <BarList
              rows={staff.map((row) => ({
                key: row.staff_id ?? row.staff_name,
                label: row.staff_name,
                sub: `${row.services} service${Number(row.services) === 1 ? "" : "s"}`,
                value: Number(row.revenue),
              }))}
              currency={currency}
            />
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Customer retention"
          description="New means their first ever paid visit falls in this period. Returning means they had visited before it started."
        />
        {!retentionRow || Number(retentionRow.total_customers) === 0 ? (
          <EmptyState>No customers visited in this period.</EmptyState>
        ) : (
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-4">
            <Figure label="New customers" value={String(retentionRow.new_customers)} />
            <Figure label="Returning" value={String(retentionRow.returning_customers)} />
            <Figure
              label="Repeat rate"
              value={`${(Number(retentionRow.repeat_rate) * 100).toFixed(1)}%`}
              emphasis
            />
            <Figure
              label="Visits per customer"
              value={Number(retentionRow.visits_per_customer).toFixed(2)}
              hint={`${retentionRow.visits} visits in total`}
            />
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Appointments by team member"
          description={
            appointmentTotals.total === 0
              ? undefined
              : `${appointmentTotals.completed} completed · ${appointmentTotals.noShow} no-shows · ${appointmentTotals.cancelled} cancelled`
          }
        />
        {appointmentRows.length === 0 ? (
          <EmptyState>No appointments in this period.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-5 py-2 font-medium">Team member</th>
                  <th className="px-5 py-2 text-right font-medium">Booked</th>
                  <th className="px-5 py-2 text-right font-medium">Confirmed</th>
                  <th className="px-5 py-2 text-right font-medium">Completed</th>
                  <th className="px-5 py-2 text-right font-medium">Cancelled</th>
                  <th className="px-5 py-2 text-right font-medium">No-show</th>
                  <th className="px-5 py-2 text-right font-medium">No-show rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {appointmentRows.map((row) => (
                  <tr key={row.staff_id ?? row.staff_name}>
                    <td className="px-5 py-2 text-ink-800">{row.staff_name}</td>
                    <Cell>{row.booked}</Cell>
                    <Cell>{row.confirmed}</Cell>
                    <Cell>{row.completed}</Cell>
                    <Cell>{row.cancelled}</Cell>
                    <Cell>{row.no_show}</Cell>
                    <td className="px-5 py-2 text-right">
                      <Badge
                        tone={
                          Number(row.no_show_rate) >= 0.2
                            ? "danger"
                            : Number(row.no_show_rate) > 0
                              ? "warning"
                              : "success"
                        }
                      >
                        {(Number(row.no_show_rate) * 100).toFixed(1)}%
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Peak times"
          description="When the salon is actually busy. Cancelled appointments are excluded; no-shows are kept, since the slot was held."
        />
        {peakRows.length === 0 ? (
          <EmptyState>No appointments in this period.</EmptyState>
        ) : (
          <div className="px-5 py-4">
            <PeakHeatmap rows={peakRows} />
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * A date box that actually follows the URL.
 *
 * The preset links below navigate to a new range, and the server duly renders
 * the new figures -- but this input stays put. `defaultValue` seeds an
 * uncontrolled input ONCE, at mount, and a client-side navigation within the
 * same route reconciles this component rather than remounting it, so the DOM
 * value is never rewritten. The dates on screen then disagree with the report
 * underneath them.
 *
 * Keying on the value forces the remount, which is what makes `defaultValue`
 * reapply. Deliberately not a controlled input: typing a date must stay purely
 * local until Apply is pressed.
 */
function DateField({ label, name, value }: { label: string; name: string; value: string }) {
  return (
    <div>
      <label htmlFor={name} className="mb-1.5 block text-sm font-medium text-ink-700">
        {label}
      </label>
      <input
        key={value}
        id={name}
        name={name}
        type="date"
        defaultValue={value}
        className="block rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
      />
    </div>
  );
}

/**
 * A quick range, anchored on TODAY rather than on whatever `to` happens to be.
 *
 * "30 days" means the last thirty days in every other reporting tool. Anchoring
 * it on the current `to` instead meant that after looking at, say, last March,
 * pressing "30 days" gave thirty days ending in March -- which reads as the
 * button having done nothing much. The salon's own today, not the server's.
 */
function Preset({
  label,
  days,
  granularity,
  timeZone,
  from,
  to,
}: {
  label: string;
  days: number;
  granularity: ReportGranularity;
  timeZone: string;
  from: string;
  to: string;
}) {
  const today = salonToday(timeZone);
  const start = addDays(today, -days);
  const active = from === start && to === today;
  const href = `/dashboard/reports?from=${start}&to=${today}&granularity=${granularity}`;

  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={
        active
          ? "rounded-lg bg-brand-50 px-2.5 py-1.5 font-medium text-brand-700"
          : "rounded-lg px-2.5 py-1.5 text-ink-600 hover:bg-ink-100"
      }
    >
      {label}
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-ink-900">{value}</p>
    </Card>
  );
}

function Figure({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p
        className={
          emphasis
            ? "mt-1 text-2xl font-semibold tabular-nums text-brand-700"
            : "mt-1 text-2xl font-semibold tabular-nums text-ink-900"
        }
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

function Cell({ children }: { children: React.ReactNode }) {
  return <td className="px-5 py-2 text-right tabular-nums text-ink-600">{children}</td>;
}

function BarList({
  rows,
  currency,
}: {
  rows: { key: string; label: string; sub: string; value: number }[];
  currency: string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <ul className="divide-y divide-ink-100">
      {rows.map((row) => (
        <li key={row.key} className="px-5 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm text-ink-800">{row.label}</span>
            <span className="shrink-0 text-sm font-medium tabular-nums text-ink-900">
              {formatMoney(row.value, currency)}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100">
              <div
                className="h-full rounded-full bg-brand-500"
                style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}
              />
            </div>
            <span className="shrink-0 text-xs text-ink-500">{row.sub}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
