import type { Metadata } from "next";

import { discardDraftAction, markPaidAction } from "./actions";
import { CommissionForm } from "./commission-form";
import { GeneratePayrollForm } from "./generate-form";
import { requireModule } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import type {
  PayrollEntryRow,
  PayrollPeriodRow,
  StaffCompensationRow,
  TeamMemberRow,
} from "@/lib/types/database";

export const metadata: Metadata = { title: "Payroll" };

export default async function PayrollPage() {
  const session = await requireModule("payroll");
  const supabase = await createClient();
  const currency = session.salon.currency;

  const [{ data: team }, { data: compensation }, { data: periods }, { data: entries }] =
    await Promise.all([
      supabase.from("team_members").select("*").eq("is_active", true).order("full_name"),
      supabase.from("staff_compensation").select("*"),
      supabase.from("payroll_periods").select("*").order("starts_on", { ascending: false }),
      supabase.from("payroll_entries").select("*").order("commission_amount", { ascending: false }),
    ]);

  /*
   * The roster, which is who payroll pays. A person with no login appears here
   * exactly like anyone else -- being payable has nothing to do with being
   * able to sign in.
   */
  const payable = (team ?? []) as TeamMemberRow[];

  const compByStaff = new Map<string, StaffCompensationRow>();
  for (const row of (compensation ?? []) as StaffCompensationRow[]) {
    compByStaff.set(row.staff_id, row);
  }

  const entriesByPeriod = new Map<string, PayrollEntryRow[]>();
  for (const entry of (entries ?? []) as PayrollEntryRow[]) {
    entriesByPeriod.set(entry.period_id, [...(entriesByPeriod.get(entry.period_id) ?? []), entry]);
  }

  return (
    <>
      <PageHeader
        title="Payroll"
        description="Commission is read straight from the receipts — voided ones excluded — and bucketed by your salon's own timezone. Salaries are pro-rated across the period."
      />

      <Card>
        <CardHeader
          title="Pay settings"
          description="Only you can see these. Each team member can see their own, and nobody else's."
        />
        {payable.length === 0 ? (
          <EmptyState>No team members yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200">
            {payable.map((person) => (
              <li key={person.id} className="px-5 py-3">
                <CommissionForm
                  staffId={person.id}
                  name={person.full_name}
                  compensation={compByStaff.get(person.id)}
                  currency={currency}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Run payroll"
          description="Periods cannot overlap, so the same work can never be paid twice."
        />
        <div className="px-5 py-4">
          <GeneratePayrollForm />
        </div>
      </Card>

      {!periods || periods.length === 0 ? (
        <Card>
          <EmptyState>No payroll periods yet.</EmptyState>
        </Card>
      ) : (
        (periods as PayrollPeriodRow[]).map((period) => {
          const periodEntries = entriesByPeriod.get(period.id) ?? [];
          return (
            <Card key={period.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {formatDate(period.starts_on)} &ndash; {formatDate(period.ends_on)}
                    <Badge tone={period.status === "paid" ? "success" : "neutral"}>
                      {period.status === "paid" ? "Paid" : "Draft"}
                    </Badge>
                  </span>
                }
                description={
                  period.status === "paid"
                    ? `Marked paid ${formatDateTime(period.paid_at)} — historical, and no longer editable.`
                    : period.notes || undefined
                }
                action={
                  period.status === "draft" ? (
                    <div className="flex items-center gap-2">
                      <form action={discardDraftAction}>
                        <input type="hidden" name="periodId" value={period.id} />
                        <Button type="submit" variant="danger" size="sm">
                          Discard
                        </Button>
                      </form>
                      <form action={markPaidAction}>
                        <input type="hidden" name="periodId" value={period.id} />
                        <Button type="submit" size="sm">
                          Mark paid
                        </Button>
                      </form>
                    </div>
                  ) : null
                }
              />

              {periodEntries.length === 0 ? (
                <EmptyState>
                  Nobody was payable in this period — no services performed, and no
                  salaries configured.
                </EmptyState>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                        <th className="px-5 py-2 font-medium">Team member</th>
                        <th className="px-5 py-2 text-right font-medium">Services</th>
                        <th className="px-5 py-2 text-right font-medium">Revenue</th>
                        <th className="px-5 py-2 text-right font-medium">Salary</th>
                        <th className="px-5 py-2 text-right font-medium">Commission</th>
                        <th className="px-5 py-2 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {periodEntries.map((entry) => (
                        <tr key={entry.id}>
                          <td className="px-5 py-2 text-ink-800">{entry.staff_name}</td>
                          <td className="px-5 py-2 text-right tabular-nums text-ink-600">
                            {entry.services_performed}
                          </td>
                          <td className="px-5 py-2 text-right tabular-nums text-ink-600">
                            {formatMoney(entry.revenue, currency)}
                          </td>
                          {/* Salary and commission are separate arrangements,
                              so a hybrid shows both rather than one winning. */}
                          <td className="px-5 py-2 text-right tabular-nums text-ink-600">
                            {Number(entry.salary_pay) > 0 ? (
                              <>
                                {formatMoney(entry.salary_pay, currency)}
                                <span className="block text-[11px] text-ink-400">
                                  {formatMoney(entry.salary_amount, currency)}/month &middot;{" "}
                                  {entry.salary_days_paid} day
                                  {entry.salary_days_paid === 1 ? "" : "s"}
                                </span>
                              </>
                            ) : (
                              <span className="text-ink-300">&mdash;</span>
                            )}
                          </td>
                          <td className="px-5 py-2 text-right tabular-nums text-ink-600">
                            {Number(entry.commission_pay) > 0 ? (
                              <>
                                {formatMoney(entry.commission_pay, currency)}
                                <span className="block text-[11px] text-ink-400">
                                  {entry.commission_basis === "percentage"
                                    ? `${(Number(entry.commission_rate) * 100).toFixed(2)}%`
                                    : entry.commission_basis === "fixed_per_service"
                                      ? `${formatMoney(entry.fixed_amount, currency)}/service`
                                      : "service rates"}
                                </span>
                              </>
                            ) : (
                              <span className="text-ink-300">&mdash;</span>
                            )}
                          </td>
                          <td className="px-5 py-2 text-right font-medium tabular-nums text-ink-900">
                            {formatMoney(entry.commission_amount, currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-ink-200 bg-ink-50 font-semibold">
                        <td className="px-5 py-2 text-ink-900">Total</td>
                        <td className="px-5 py-2 text-right tabular-nums text-ink-700">
                          {periodEntries.reduce((n, e) => n + e.services_performed, 0)}
                        </td>
                        <td className="px-5 py-2 text-right tabular-nums text-ink-700">
                          {formatMoney(period.total_revenue, currency)}
                        </td>
                        <td className="px-5 py-2 text-right tabular-nums text-ink-700">
                          {formatMoney(
                            periodEntries.reduce((n, e) => n + Number(e.salary_pay), 0),
                            currency,
                          )}
                        </td>
                        <td className="px-5 py-2 text-right tabular-nums text-ink-700">
                          {formatMoney(
                            periodEntries.reduce((n, e) => n + Number(e.commission_pay), 0),
                            currency,
                          )}
                        </td>
                        <td className="px-5 py-2 text-right tabular-nums text-ink-900">
                          {formatMoney(period.total_commission, currency)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </Card>
          );
        })
      )}
    </>
  );
}
