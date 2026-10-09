import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/types/database";
import type { SessionContext } from "@/lib/auth/session";

/**
 * Every sensitive action in the product records one of these. The list grows
 * phase by phase; keeping the strings in one place stops them drifting apart
 * and gives the audit log filter a fixed vocabulary to offer.
 */
export const AUDIT_ACTIONS = {
  // Phase 1 -- auth, tenancy, staff
  SALON_CREATED: "salon.created",
  SALON_SETTINGS_CHANGED: "salon.settings_changed",
  STAFF_INVITED: "staff.invited",
  STAFF_INVITE_REVOKED: "staff.invite_revoked",
  STAFF_INVITE_ACCEPTED: "staff.invite_accepted",
  STAFF_ROLE_CHANGED: "staff.role_changed",
  STAFF_DEACTIVATED: "staff.deactivated",
  STAFF_REACTIVATED: "staff.reactivated",

  // Phase 2 -- catalogue, customers, consent
  SERVICE_CREATED: "service.created",
  SERVICE_UPDATED: "service.updated",
  SERVICE_ARCHIVED: "service.archived",
  SERVICE_RESTORED: "service.restored",
  DEAL_CREATED: "deal.created",
  DEAL_UPDATED: "deal.updated",
  DEAL_ARCHIVED: "deal.archived",
  CONSENT_TEMPLATE_CREATED: "consent_template.created",
  CONSENT_TEMPLATE_UPDATED: "consent_template.updated",
  CONSENT_TEMPLATE_ARCHIVED: "consent_template.archived",
  CUSTOMER_CREATED: "customer.created",
  CUSTOMER_UPDATED: "customer.updated",
  CONSENT_FORM_CREATED: "consent_form.created",
  CONSENT_FORM_VIEWED: "consent_form.viewed",

  // Phase 3 -- booking
  APPOINTMENT_BOOKED: "appointment.booked",
  APPOINTMENT_RESCHEDULED: "appointment.rescheduled",
  /** Written by update_appointment_services() in Postgres. */
  APPOINTMENT_UPDATED: "appointment.updated",
  APPOINTMENT_CONFIRMED: "appointment.confirmed",
  APPOINTMENT_COMPLETED: "appointment.completed",
  APPOINTMENT_CANCELLED: "appointment.cancelled",
  APPOINTMENT_NO_SHOW: "appointment.no_show",

  // Phase 4 -- POS and loyalty.
  // These three are written by the checkout functions in Postgres, not by
  // logAudit(), because the tables they touch have no write policies at all.
  // They are listed here so the audit log filter offers them.
  RECEIPT_CREATED: "receipt.created",
  RECEIPT_VOIDED: "receipt.voided",
  LOYALTY_REDEEMED: "loyalty.redeemed",

  // Phase 5 -- payroll. The first two are written by the Postgres functions.
  PAYROLL_GENERATED: "payroll.generated",
  PAYROLL_MARKED_PAID: "payroll.marked_paid",
  COMMISSION_RATE_CHANGED: "payroll.commission_rate_changed",

  // Staff identity documents. An ID card is held about a real person and is
  // owner-only, so every touch of one is recorded -- reads included, exactly
  // as consent form views are.
  STAFF_DOCUMENT_UPLOADED: "staff_document.uploaded",
  STAFF_DOCUMENT_VIEWED: "staff_document.viewed",
  STAFF_DOCUMENT_REMOVED: "staff_document.removed",

  // Payments. The first two are written by the Postgres functions, for the
  // same reason the receipt ones are: `payments` has no write policy at all.
  PAYMENT_RECORDED: "payment.recorded",
  PAYMENT_REFUNDED: "payment.refunded",

  // The roster, and the optional logins attached to it.
  TEAM_MEMBER_ADDED: "team_member.added",
  TEAM_MEMBER_UPDATED: "team_member.updated",
  TEAM_MEMBER_DEACTIVATED: "team_member.deactivated",
  TEAM_MEMBER_REACTIVATED: "team_member.reactivated",
  LOGIN_LINKED: "team_member.login_linked",
  LOGIN_UNLINKED: "team_member.login_unlinked",

  // Roles and what they may reach.
  ROLE_CREATED: "role.created",
  ROLE_UPDATED: "role.updated",
  ROLE_DELETED: "role.deleted",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

interface AuditEntry {
  action: AuditAction | (string & {});
  entityType?: string;
  entityId?: string | null;
  metadata?: Record<string, Json>;
}

/**
 * Append an entry to the audit log.
 *
 * Written through the RLS-bound client: the insert policy pins salon_id to the
 * caller's salon and actor_id to the caller, so a forged entry is rejected by
 * the database rather than trusted from here. There is no update or delete
 * policy on audit_logs at all, so entries are append-only.
 *
 * Audit failures are logged but never thrown -- a logging hiccup must not roll
 * back the business action the user just completed.
 */
export async function logAudit(
  session: SessionContext,
  entry: AuditEntry,
): Promise<void> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.from("audit_logs").insert({
      salon_id: session.profile.salon_id,
      actor_id: session.userId,
      actor_email: session.email,
      actor_role: session.profile.role,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      metadata: (entry.metadata ?? {}) as Json,
    });

    if (error) {
      console.error("[audit] failed to record %s: %s", entry.action, error.message);
    }
  } catch (error) {
    console.error("[audit] failed to record %s:", entry.action, error);
  }
}
