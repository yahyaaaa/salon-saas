"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/components/ui";
import type { AppModule } from "@/lib/types/database";

interface NavItem {
  href: string;
  label: string;
  /**
   * The module this page belongs to, mirroring the guard on the page and the
   * `has_module()` call in its policies. Undefined means everyone: the
   * overview, their own account, and their own earnings are not delegated
   * powers and are never taken away.
   */
  module?: AppModule;
  /** Not built yet -- shown greyed out so the build order stays visible. */
  comingSoon?: boolean;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/calendar", label: "Calendar & appointments" },
  { href: "/dashboard/customers", label: "Customers", module: "customers" },
  { href: "/dashboard/pos", label: "POS", module: "pos" },
  { href: "/dashboard/services", label: "Services", module: "services" },
  { href: "/dashboard/payroll", label: "Payroll", module: "payroll" },
  { href: "/dashboard/earnings", label: "My earnings" },
  { href: "/dashboard/reports", label: "Reports", module: "reports" },
  { href: "/dashboard/team", label: "Team", module: "team" },
  { href: "/dashboard/audit", label: "Audit log", module: "audit" },
  { href: "/dashboard/settings", label: "Settings", module: "settings" },
  { href: "/dashboard/account", label: "My account" },
];

/**
 * Hiding a link is a courtesy, not a control. Every page behind these guards
 * itself, and every policy behind it asks `has_module()` -- so a hand-typed
 * URL reaches a refusal, not the data.
 *
 * The calendar has no module: a therapist with no permissions at all still
 * sees their own diary, because the appointments policy admits their own rows
 * regardless.
 */
export function SidebarNav({ modules }: { modules: AppModule[] }) {
  const pathname = usePathname();
  const held = new Set(modules);
  const items = NAV.filter((item) => !item.module || held.has(item.module));

  return (
    <nav className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap">
      {items.map((item) => {
        const isActive =
          pathname === item.href ||
          (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));

        if (item.comingSoon) {
          return (
            <span
              key={item.href}
              className="flex cursor-not-allowed items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-ink-300"
              title="Coming in a later phase"
            >
              {item.label}
              <span className="text-[10px] font-medium uppercase tracking-wide">Soon</span>
            </span>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-brand-50 text-brand-700"
                : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
