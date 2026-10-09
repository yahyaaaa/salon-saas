import Link from "next/link";
import type { Metadata } from "next";

import { requireSession, ROLE_DESCRIPTIONS } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Alert, Badge, Card, CardHeader, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Overview" };

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const session = await requireSession();
  const params = await searchParams;
  const { profile, salon } = session;

  const supabase = await createClient();

  // RLS scopes this count to the caller's salon; no salon_id filter is needed
  // for correctness, but it is left in as a readable second line of defence.
  const { count: teamCount } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", salon.id)
    .eq("is_active", true);

  const daysLeft = trialDaysRemaining(salon.trial_ends_at);

  return (
    <>
      <PageHeader
        title={`Welcome${profile.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}`}
        description={`${session.role?.name ?? "No role"} at ${salon.name}`}
      />

      {params.denied ? (
        <Alert tone="warning">
          That area is restricted to salon owners.
        </Alert>
      ) : null}

      {salon.subscription_status === "trialing" ? (
        <Alert tone="info">
          Your free trial has <strong>{daysLeft} {daysLeft === 1 ? "day" : "days"}</strong>{" "}
          left. Billing is wired up in Phase 8.
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Active team members" value={teamCount ?? 0} />
        <Stat label="Timezone" value={salon.timezone} />
        <Stat label="Currency" value={salon.currency} />
      </div>

      <Card>
        <CardHeader
          title="Your access"
          description={ROLE_DESCRIPTIONS[profile.role]}
        />
        <div className="space-y-3 px-5 py-4 text-sm text-ink-600">
          <p>
            Everything you see is scoped to <strong>{salon.name}</strong>. That scoping is
            enforced by Postgres Row Level Security, not by the interface &mdash; another
            salon&rsquo;s data is unreachable even through a crafted request.
          </p>
          {profile.role === "owner" ? (
            <p>
              Start by{" "}
              <Link href="/dashboard/team" className="font-medium text-brand-700 hover:underline">
                inviting your team
              </Link>{" "}
              and reviewing your{" "}
              <Link href="/dashboard/settings" className="font-medium text-brand-700 hover:underline">
                salon settings
              </Link>
              .
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Build progress"
          description="Phases 1 to 6 are complete. The rest ships in order."
        />
        <ul className="divide-y divide-ink-200">
          {PHASES.map((phase) => (
            <li key={phase.n} className="flex items-center justify-between gap-3 px-5 py-2.5">
              <span className="text-sm text-ink-700">
                <span className="mr-2 text-xs text-ink-400">{phase.n}</span>
                {phase.label}
              </span>
              <Badge tone={phase.done ? "success" : "neutral"}>
                {phase.done ? "Done" : "Planned"}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

/** Whole days left on the trial, floored at zero. */
function trialDaysRemaining(trialEndsAt: string): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const remaining = new Date(trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(remaining / msPerDay));
}

const PHASES = [
  { n: 1, label: "Auth + multi-tenant scaffolding", done: true },
  { n: 2, label: "Services, settings, customers, consent forms", done: true },
  { n: 3, label: "Appointment / booking calendar", done: true },
  { n: 4, label: "POS receipts + loyalty earn/redeem", done: true },
  { n: 5, label: "Payroll", done: true },
  { n: 6, label: "Reporting & analytics", done: true },
  { n: 7, label: "Audit logging (threaded through each phase)", done: false },
  { n: 8, label: "Stripe subscription billing + access gating", done: false },
];

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold text-ink-900">{value}</p>
    </Card>
  );
}
