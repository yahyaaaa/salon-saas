import type { ReactNode } from "react";

import { requireSession } from "@/lib/auth/session";
import { SidebarNav } from "@/components/sidebar-nav";
import { SignOutButton } from "@/components/sign-out-button";
import { Badge } from "@/components/ui";
import type { SubscriptionStatus } from "@/lib/types/database";

const SUBSCRIPTION_TONE: Record<
  SubscriptionStatus,
  "success" | "brand" | "warning" | "danger"
> = {
  active: "success",
  trialing: "brand",
  past_due: "warning",
  incomplete: "warning",
  unpaid: "danger",
  canceled: "danger",
};

const SUBSCRIPTION_LABEL: Record<SubscriptionStatus, string> = {
  active: "Active",
  trialing: "Trial",
  past_due: "Past due",
  incomplete: "Incomplete",
  unpaid: "Unpaid",
  canceled: "Cancelled",
};

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const { profile, salon } = session;

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="flex shrink-0 flex-col gap-6 border-b border-ink-200 bg-white px-4 py-5 lg:h-dvh lg:w-64 lg:sticky lg:top-0 lg:border-r lg:border-b-0">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            {salon.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-900">{salon.name}</p>
            <p className="text-xs text-ink-500">
              {salon.business_type === "aesthetic_clinic" ? "Aesthetic clinic" : "Salon"}
            </p>
          </div>
        </div>

        <SidebarNav modules={[...session.modules]} />

        <div className="mt-auto space-y-3 border-t border-ink-200 pt-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink-500">Subscription</span>
            <Badge tone={SUBSCRIPTION_TONE[salon.subscription_status]}>
              {SUBSCRIPTION_LABEL[salon.subscription_status]}
            </Badge>
          </div>

          <div>
            <p className="truncate text-sm font-medium text-ink-900">
              {profile.full_name || session.email}
            </p>
            <p className="truncate text-xs text-ink-500">{session.role?.name ?? "No role"}</p>
          </div>

          <SignOutButton />
        </div>
      </aside>

      <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto w-full max-w-5xl space-y-6">{children}</div>
      </main>
    </div>
  );
}
