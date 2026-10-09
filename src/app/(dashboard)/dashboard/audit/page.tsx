import type { Metadata } from "next";

import { requireModule } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import type { AuditLogRow, ProfileRow } from "@/lib/types/database";

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 50;

/** Human labels for the action vocabulary in @/lib/audit. */
const ACTION_LABELS: Record<string, string> = {
  "salon.created": "Salon created",
  "salon.settings_changed": "Settings changed",
  "staff.invited": "Staff invited",
  "staff.invite_revoked": "Invitation revoked",
  "staff.invite_accepted": "Invitation accepted",
  "staff.role_changed": "Role changed",
  "staff.deactivated": "Staff deactivated",
  "staff.reactivated": "Staff reactivated",
  "service.created": "Service created",
  "service.updated": "Service updated",
  "service.archived": "Service archived",
  "service.restored": "Service restored",
  "deal.created": "Deal created",
  "deal.updated": "Deal updated",
  "deal.archived": "Deal archived",
  "consent_template.created": "Consent template created",
  "consent_template.updated": "Consent template updated",
  "consent_template.archived": "Consent template archived",
  "customer.created": "Customer created",
  "customer.updated": "Customer updated",
  "consent_form.created": "Consent form collected",
  "consent_form.viewed": "Consent signature viewed",
  "appointment.booked": "Appointment booked",
  "appointment.rescheduled": "Appointment rescheduled",
  "appointment.confirmed": "Appointment confirmed",
  "appointment.completed": "Appointment completed",
  "appointment.cancelled": "Appointment cancelled",
  "appointment.no_show": "No-show recorded",
  "receipt.created": "Receipt issued",
  "receipt.voided": "Receipt voided",
  "loyalty.redeemed": "Loyalty redeemed",
  "payroll.generated": "Payroll generated",
  "payroll.marked_paid": "Payroll marked paid",
  "payroll.commission_rate_changed": "Pay basis changed",
  "staff_document.uploaded": "Staff ID document uploaded",
  "staff_document.viewed": "Staff ID document viewed",
  "staff_document.removed": "Staff ID document removed",
  "payment.recorded": "Payment received",
  "payment.refunded": "Payment refunded",
  "appointment.updated": "Appointment services changed",
  "team_member.added": "Team member added",
  "team_member.updated": "Team member updated",
  "team_member.deactivated": "Team member deactivated",
  "team_member.reactivated": "Team member reactivated",
  "team_member.login_linked": "Login linked to a team member",
  "team_member.login_unlinked": "Login unlinked",
  "role.created": "Role created",
  "role.updated": "Role permissions changed",
  "role.deleted": "Role deleted",
};

export default async function AuditPage({ searchParams }: PageProps<"/dashboard/audit">) {
  await requireModule("audit");

  const params = await searchParams;
  const actionFilter = typeof params.action === "string" ? params.action : "";
  const actorFilter = typeof params.actor === "string" ? params.actor : "";
  const fromFilter = typeof params.from === "string" ? params.from : "";
  const toFilter = typeof params.to === "string" ? params.to : "";

  const supabase = await createClient();

  // Owner-only by RLS: audit_logs has no policy that lets other roles read it.
  let query = supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (actionFilter) query = query.eq("action", actionFilter);
  if (actorFilter) query = query.eq("actor_id", actorFilter);
  if (fromFilter) query = query.gte("created_at", `${fromFilter}T00:00:00Z`);
  if (toFilter) query = query.lte("created_at", `${toFilter}T23:59:59Z`);

  const [{ data: entries }, { data: actors }] = await Promise.all([
    query,
    supabase.from("profiles").select("id, full_name, email").order("full_name"),
  ]);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only record of sensitive actions. It cannot be edited or deleted, here or anywhere else."
      />

      <Card>
        <CardHeader title="Filter" />
        <form className="grid gap-3 px-5 py-4 sm:grid-cols-5 sm:items-end">
          <div>
            <label htmlFor="action" className="mb-1.5 block text-xs font-medium text-ink-600">
              Action
            </label>
            <select
              id="action"
              name="action"
              defaultValue={actionFilter}
              className="block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All actions</option>
              {Object.entries(ACTION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="actor" className="mb-1.5 block text-xs font-medium text-ink-600">
              Actor
            </label>
            <select
              id="actor"
              name="actor"
              defaultValue={actorFilter}
              className="block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Anyone</option>
              {(actors ?? []).map((actor: Pick<ProfileRow, "id" | "full_name" | "email">) => (
                <option key={actor.id} value={actor.id}>
                  {actor.full_name || actor.email}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="from" className="mb-1.5 block text-xs font-medium text-ink-600">
              From
            </label>
            <input
              id="from"
              name="from"
              type="date"
              defaultValue={fromFilter}
              className="block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="to" className="mb-1.5 block text-xs font-medium text-ink-600">
              To
            </label>
            <input
              id="to"
              name="to"
              type="date"
              defaultValue={toFilter}
              className="block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            />
          </div>

          <button
            type="submit"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Apply
          </button>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="Entries"
          description={`Most recent ${PAGE_SIZE} matching entries.`}
        />

        {!entries || entries.length === 0 ? (
          <EmptyState>No audit entries match those filters.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200">
            {entries.map((entry: AuditLogRow) => (
              <li key={entry.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge tone="brand">{ACTION_LABELS[entry.action] ?? entry.action}</Badge>
                    <span className="text-sm text-ink-700">
                      {entry.actor_email ?? "system"}
                      {entry.actor_role ? (
                        <span className="text-ink-400"> ({entry.actor_role})</span>
                      ) : null}
                    </span>
                  </div>
                  <time
                    dateTime={entry.created_at}
                    className="text-xs tabular-nums text-ink-500"
                  >
                    {new Date(entry.created_at).toLocaleString()}
                  </time>
                </div>

                {entry.metadata && Object.keys(entry.metadata).length > 0 ? (
                  <pre className="mt-2 overflow-x-auto rounded-md bg-ink-100 px-3 py-2 text-xs text-ink-600">
                    {JSON.stringify(entry.metadata, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
