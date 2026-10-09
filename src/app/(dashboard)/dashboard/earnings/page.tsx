import type { Metadata } from "next";

import { requireRole } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { Alert, Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import type {
  PayrollEntryRow,
  ReceiptLineItemRow,
  StaffCompensationRow,
} from "@/lib/types/database";

export const metadata: Metadata = { title: "My earnings" };

const RECENT_SERVICES = 50;

export default async function EarningsPage() {
  // Read-only, and scoped to the caller by RLS rather than by these queries:
  // payroll_entries and receipt_line_items both restrict a therapist to their
  // own rows, and staff_compensation to their own rate.
  const session = await requireRole("staff", "owner");
  const supabase = await createClient();
  const currency = session.salon.currency;

  /*
   * Everything here keys on the ROSTER entry, not the login. A login with no
   * roster entry performs no services and so has nothing to show -- the
   * queries are skipped entirely rather than returning someone else's rows by
   * accident.
   */
  const rosterId = session.teamMemberId;

  const [{ data: compensation }, { data: entries }, { data: lines }] = rosterId
    ? await Promise.all([
        supabase
          .from("staff_compensation")
          .select("*")
          .eq("staff_id", rosterId)
          .maybeSingle(),
        supabase
          .from("payroll_entries")
          .select("*")
          .eq("staff_id", rosterId)
          .order("period_starts_on", { ascending: false }),
        // The receipt header is not readable by a therapist; `performed_at`
        // lives on the line itself precisely so this history stands alone.
        supabase
          .from("receipt_line_items")
          .select("*")
          .eq("staff_id", rosterId)
          .order("performed_at", { ascending: false })
          .limit(RECENT_SERVICES),
      ])
    : [{ data: null }, { data: [] }, { data: [] }];

  const comp = compensation as StaffCompensationRow | null;
  const payrollEntries = (entries ?? []) as PayrollEntryRow[];
  const services = (lines ?? []) as ReceiptLineItemRow[];

  const paidToDate = payrollEntries
    .filter((e) => e.status === "paid")
    .reduce((sum, e) => sum + Number(e.commission_amount), 0);
  const pending = payrollEntries
    .filter((e) => e.status === "draft")
    .reduce((sum, e) => sum + Number(e.commission_amount), 0);

  return (
    <>
      <PageHeader
        title="My earnings"
        description="Your own services and commission. Payroll itself is run by the salon owner."
      />

      {rosterId ? null : (
        <Alert tone="info">
          This account is not linked to anyone on the team, so no services or earnings
          are recorded against it. If that is wrong, an owner can link it from the Team
          page.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Paid to date" value={formatMoney(paidToDate, currency)} />
        <Stat label="Pending (draft periods)" value={formatMoney(pending, currency)} />
        {/*
          Salary and commission are separate arrangements, so "your rate" has
          to be able to say both -- or neither, when each service carries its
          own rate and the person has none of their own.
        */}
        <Stat label="How you are paid" value={describePay(comp, currency)} />
      </div>

      <Card>
        <CardHeader
          title="Payroll history"
          description="A period stops changing once the owner marks it paid."
        />
        {payrollEntries.length === 0 ? (
          <EmptyState>No payroll periods cover your work yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-5 py-2 font-medium">Period</th>
                  <th className="px-5 py-2 text-right font-medium">Services</th>
                  <th className="px-5 py-2 text-right font-medium">Revenue</th>
                  <th className="px-5 py-2 text-right font-medium">Salary</th>
                  <th className="px-5 py-2 text-right font-medium">Commission</th>
                  <th className="px-5 py-2 text-right font-medium">Total</th>
                  <th className="px-5 py-2 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {payrollEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-5 py-2 text-ink-800">
                      {formatDate(entry.period_starts_on)} &ndash;{" "}
                      {formatDate(entry.period_ends_on)}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-ink-600">
                      {entry.services_performed}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-ink-600">
                      {formatMoney(entry.revenue, currency)}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-ink-600">
                      {Number(entry.salary_pay) > 0
                        ? formatMoney(entry.salary_pay, currency)
                        : "—"}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-ink-600">
                      {Number(entry.commission_pay) > 0
                        ? formatMoney(entry.commission_pay, currency)
                        : "—"}
                    </td>
                    <td className="px-5 py-2 text-right font-medium tabular-nums text-ink-900">
                      {formatMoney(entry.commission_amount, currency)}
                    </td>
                    <td className="px-5 py-2 text-right">
                      <Badge tone={entry.status === "paid" ? "success" : "neutral"}>
                        {entry.status === "paid"
                          ? `Paid ${formatDate(entry.paid_at)}`
                          : "Draft"}
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
          title="Services performed"
          description={`Your most recent ${RECENT_SERVICES}.`}
        />
        {services.length === 0 ? (
          <EmptyState>Nothing recorded against you yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200">
            {services.map((line) => (
              <li
                key={line.id}
                className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5"
              >
                <span className="text-sm text-ink-800">
                  {line.service_name}
                  {line.quantity > 1 ? (
                    <span className="ml-1.5 text-xs text-ink-500">&times;{line.quantity}</span>
                  ) : null}
                  <span className="ml-2 text-xs text-ink-500">
                    {formatDateTime(line.performed_at)}
                  </span>
                </span>
                <span className="text-sm tabular-nums text-ink-700">
                  {formatMoney(line.line_total, currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/**
 * How this person is paid, in one line.
 *
 * Salary and commission are independent, so this has to be able to say both,
 * either, or neither -- "neither" being the case where every service carries
 * its own rate and the person has none of their own.
 */
function describePay(
  comp: { commission_basis: string | null; commission_rate: number | null;
          fixed_amount: number | null; salary_amount: number } | null | undefined,
  currency: string,
): string {
  if (!comp) return "Not set";

  const parts: string[] = [];
  if (Number(comp.salary_amount) > 0) {
    parts.push(`${formatMoney(comp.salary_amount, currency)}/month`);
  }

  if (comp.commission_basis === "percentage") {
    parts.push(`${(Number(comp.commission_rate ?? 0) * 100).toFixed(2)}%`);
  } else if (comp.commission_basis === "fixed_per_service") {
    parts.push(`${formatMoney(comp.fixed_amount ?? 0, currency)}/service`);
  } else if (comp.commission_basis === null) {
    parts.push("each service's own rate");
  }

  return parts.length === 0 ? "Salary only" : parts.join(" + ");
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-ink-900">{value}</p>
    </Card>
  );
}
