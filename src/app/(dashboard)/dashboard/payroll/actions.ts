"use server";

import { revalidatePath } from "next/cache";

import { AUDIT_ACTIONS, logAudit } from "@/lib/audit";
import { assertModule, requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { commissionSchema, fieldErrors, payrollPeriodSchema } from "@/lib/validation";

export interface PayrollFormState {
  message?: string;
  success?: string;
  errors?: Record<string, string>;
}

/**
 * Set a team member's commission.
 *
 * Kept in `staff_compensation`, not on `profiles`: everyone in the salon can
 * read profiles, and what a colleague earns is not theirs to see.
 */
export async function saveCommissionAction(
  _prevState: PayrollFormState,
  formData: FormData,
): Promise<PayrollFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "payroll");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = commissionSchema.safeParse({
    staffId: formData.get("staffId"),
    commissionBasis: formData.get("commissionBasis") ?? "",
    commissionPercent: formData.get("commissionPercent") || 0,
    fixedAmount: formData.get("fixedAmount") || 0,
    salaryAmount: formData.get("salaryAmount") || 0,
    joiningDate: formData.get("joiningDate") ?? "",
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const input = parsed.data;
  const supabase = await createClient();

  const { data: before } = await supabase
    .from("staff_compensation")
    .select("commission_basis, commission_rate, fixed_amount, salary_amount")
    .eq("staff_id", input.staffId)
    .maybeSingle();

  // Every column is written explicitly. PostgREST sends an explicit NULL for
  // any key omitted from an upsert, which would override the column default
  // and trip the NOT NULL constraints.
  const { error } = await supabase.from("staff_compensation").upsert(
    {
      staff_id: input.staffId,
      salon_id: session.profile.salon_id,
      /*
       * Salary and commission are independent, so both are always written.
       * An empty basis is stored as NULL, which means "not set -- use the
       * service's default", and is deliberately different from "none".
       */
      commission_basis: input.commissionBasis === "" ? null : input.commissionBasis,
      commission_rate:
        input.commissionBasis === "percentage"
          ? Number((input.commissionPercent / 100).toFixed(4))
          : null,
      fixed_amount: input.commissionBasis === "fixed_per_service" ? input.fixedAmount : null,
      salary_amount: input.salaryAmount,
      // Employment data rather than a pay setting, so it is kept whichever
      // basis is in force.
      joining_date: input.joiningDate ?? null,
    },
    { onConflict: "staff_id" },
  );

  if (error) return { message: error.message };

  await logAudit(session, {
    action: AUDIT_ACTIONS.COMMISSION_RATE_CHANGED,
    entityType: "staff_compensation",
    entityId: input.staffId,
    metadata: {
      from: before ? describeBasis(before) : "not set",
      to: describeBasis({
        commission_basis: input.commissionBasis === "" ? null : input.commissionBasis,
        commission_rate: input.commissionPercent / 100,
        fixed_amount: input.fixedAmount,
        salary_amount: input.salaryAmount,
      }),
    },
  });

  revalidatePath("/dashboard/payroll");
  return { success: "Pay settings saved." };
}

/**
 * A pay basis in one line, for the audit trail.
 *
 * A local helper, not an export: a "use server" module may only export async
 * functions.
 */
function describeBasis(comp: {
  commission_basis: string | null;
  commission_rate: number | string | null;
  fixed_amount: number | string | null;
  salary_amount: number | string | null;
}): string {
  const parts: string[] = [];

  if (Number(comp.salary_amount ?? 0) > 0) {
    parts.push(`salary ${comp.salary_amount} per month`);
  }

  switch (comp.commission_basis) {
    case "percentage":
      parts.push(`commission ${Number(comp.commission_rate ?? 0) * 100}%`);
      break;
    case "fixed_per_service":
      parts.push(`commission ${comp.fixed_amount} per service`);
      break;
    case "none":
      parts.push("no commission");
      break;
    default:
      parts.push("commission from each service's own rate");
  }

  return parts.join(" + ");
}

/**
 * Generate a draft payroll period.
 *
 * All the arithmetic happens in `generate_payroll_period()`, which reads the
 * receipt lines directly — excluding voided receipts, and bucketing by the
 * salon's own timezone rather than UTC.
 */
export async function generatePayrollAction(
  _prevState: PayrollFormState,
  formData: FormData,
): Promise<PayrollFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "payroll");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = payrollPeriodSchema.safeParse({
    startsOn: formData.get("startsOn"),
    endsOn: formData.get("endsOn"),
    notes: formData.get("notes") ?? "",
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.rpc("generate_payroll_period", {
    p_starts_on: parsed.data.startsOn,
    p_ends_on: parsed.data.endsOn,
    p_notes: parsed.data.notes,
  });

  if (error) {
    // 23P01 is the exclusion constraint: these dates overlap an existing period.
    if (error.code === "23P01") {
      return {
        message:
          "Those dates overlap a payroll period that already exists. Paying the same work twice is not allowed — discard the other draft, or choose different dates.",
      };
    }
    return { message: error.message.replace(/^.*?:\s*/, "") };
  }

  revalidatePath("/dashboard/payroll");
  return { success: "Payroll period generated." };
}

/** Freeze a period. After this it is viewable but not editable, per the brief. */
export async function markPaidAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "payroll");

  const periodId = String(formData.get("periodId") ?? "");
  if (!periodId) return;

  const supabase = await createClient();
  await supabase.rpc("mark_payroll_paid", { p_period_id: periodId });

  revalidatePath("/dashboard/payroll");
}

/** Discard a draft that was generated for the wrong dates. Paid periods stay. */
export async function discardDraftAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "payroll");

  const periodId = String(formData.get("periodId") ?? "");
  if (!periodId) return;

  const supabase = await createClient();
  // The policy only covers drafts, so a paid period simply matches no rows.
  await supabase.from("payroll_periods").delete().eq("id", periodId).eq("status", "draft");

  revalidatePath("/dashboard/payroll");
}
