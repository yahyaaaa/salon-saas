import type { AppModule } from "@/lib/types/database";

/**
 * The grantable areas of the product, in the order they appear in the sidebar
 * so the permission checklist reads like the navigation it controls.
 *
 * NOT a "use client" module, deliberately. Both the Team page (a server
 * component, rendering the summary of what each role reaches) and the role
 * form (a client component, rendering the checkboxes) need this list. Putting
 * it in either one would hand the other a reference it cannot call, and the
 * page 500s at runtime rather than failing the build -- see rule 9 in
 * CLAUDE.md, which exists because of exactly this mistake.
 *
 * Deliberately absent:
 *   Overview, My account   every login has them
 *   My earnings            always available, and shows only the holder's own
 *                          figures -- not a delegated power
 *   Calendar               a therapist sees their OWN diary whatever their
 *                          role holds; the module grants managing everyone's
 */
export const MODULES: { module: AppModule; label: string; detail: string }[] = [
  {
    module: "calendar",
    label: "Calendar & appointments",
    detail: "Book, reschedule and cancel for the whole salon.",
  },
  {
    module: "customers",
    label: "Customers",
    detail: "Customer profiles and their consent records.",
  },
  { module: "pos", label: "POS", detail: "Take payment, and read past receipts." },
  {
    module: "services",
    label: "Services",
    detail: "The price list, deals, and consent templates.",
  },
  { module: "payroll", label: "Payroll", detail: "Pay settings and payroll runs." },
  { module: "reports", label: "Reports", detail: "The reporting suite." },
  {
    module: "team",
    label: "Team",
    detail: "The roster, accounts, invitations — and these roles.",
  },
  { module: "audit", label: "Audit log", detail: "Who did what, and when." },
  { module: "settings", label: "Settings", detail: "Salon details, hours and loyalty." },
];
