import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { ConsentForm } from "./consent-form";
import { SignatureViewer } from "./signature-viewer";
import { AttachmentLink } from "./attachment-link";
import { CustomerForm } from "../customer-form";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { ageFrom, formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { instantToSalonDate, instantToSalonTime, formatDayLabel } from "@/lib/time";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import type {
  AppointmentRow,
  ConsentFormAttachmentRow,
  ReceiptRow,
  LoyaltyTransactionRow,
  AppointmentStatus,
  ConsentFormResponseRow,
  ConsentFormRow,
  ConsentTemplateItemRow,
  ConsentTemplateRow,
  ProfileRow,
  ServiceRow,
} from "@/lib/types/database";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerDetailPage({
  params,
}: PageProps<"/dashboard/customers/[customerId]">) {
  const { customerId } = await params;
  const session = await requireSession();
  const supabase = await createClient();

  // RLS scopes this to the caller's salon, so a foreign id simply is not found.
  const { data: customer } = await supabase
    .from("customers")
    .select("*")
    .eq("id", customerId)
    .maybeSingle();

  if (!customer) notFound();

  const canManage = session.profile.role === "owner" || session.profile.role === "receptionist";

  const [
    { data: forms },
    { data: responses },
    { data: attachments },
    { data: services },
    { data: templates },
    { data: templateItems },
    { data: team },
    { data: appointments },
    { data: loyaltyBalance },
    { data: receipts },
    { data: ledger },
  ] = await Promise.all([
    // Only the forms this user is allowed to see come back -- a therapist gets
    // just their own. That filtering is the database's, not ours.
    supabase
      .from("consent_forms")
      .select("*")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    supabase.from("consent_form_responses").select("*").order("sort_order"),
    // RLS narrows these to the forms this user may read, exactly as it does
    // the forms themselves.
    supabase.from("consent_form_attachments").select("*").order("created_at"),
    supabase.from("services").select("*").eq("is_active", true).order("name"),
    supabase.from("consent_templates").select("*").eq("is_active", true).order("name"),
    supabase.from("consent_template_items").select("*").order("sort_order"),
    supabase.from("profiles").select("id, full_name, email"),
    // RLS narrows this to the caller: a therapist sees only their own visits
    // with this customer.
    supabase
      .from("appointments")
      .select("*")
      .eq("customer_id", customerId)
      .order("starts_at", { ascending: false }),
    // Loyalty and spend are front-desk information; a therapist gets neither.
    canManage
      ? supabase.rpc("customer_loyalty_balance", { p_customer_id: customerId })
      : Promise.resolve({ data: null }),
    canManage
      ? supabase
          .from("receipts")
          .select("*")
          .eq("customer_id", customerId)
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] as ReceiptRow[] }),
    canManage
      ? supabase
          .from("loyalty_transactions")
          .select("*")
          .eq("customer_id", customerId)
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] as LoyaltyTransactionRow[] }),
  ]);

  const nameById = new Map<string, string>();
  for (const p of (team ?? []) as Pick<ProfileRow, "id" | "full_name" | "email">[]) {
    nameById.set(p.id, p.full_name || p.email);
  }
  const serviceById = new Map<string, string>();
  for (const s of (services ?? []) as ServiceRow[]) serviceById.set(s.id, s.name);

  const responsesByForm = new Map<string, ConsentFormResponseRow[]>();
  for (const r of (responses ?? []) as ConsentFormResponseRow[]) {
    responsesByForm.set(r.form_id, [...(responsesByForm.get(r.form_id) ?? []), r]);
  }

  const attachmentsByForm = new Map<string, ConsentFormAttachmentRow[]>();
  for (const a of (attachments ?? []) as ConsentFormAttachmentRow[]) {
    attachmentsByForm.set(a.form_id, [...(attachmentsByForm.get(a.form_id) ?? []), a]);
  }

  const itemsByTemplate: Record<string, ConsentTemplateItemRow[]> = {};
  for (const item of (templateItems ?? []) as ConsentTemplateItemRow[]) {
    (itemsByTemplate[item.template_id] ??= []).push(item);
  }

  const timeZone = session.salon.timezone;
  const visits = (appointments ?? []) as AppointmentRow[];

  // Only visits that actually happened, or are about to, are worth attaching a
  // consent form to.
  const attachable = visits
    .filter((a) => a.status !== "cancelled" && a.status !== "no_show")
    .slice(0, 25)
    .map((a) => ({
      id: a.id,
      serviceId: a.service_id,
      label: `${formatDayLabel(instantToSalonDate(a.starts_at, timeZone))} ${instantToSalonTime(
        a.starts_at,
        timeZone,
      )} — ${serviceById.get(a.service_id) ?? "Treatment"}`,
    }));

  const age = ageFrom(customer.date_of_birth);
  const signedForms = ((forms ?? []) as ConsentFormRow[]).filter((f) => f.signed_at);

  return (
    <>
      <PageHeader
        title={customer.full_name}
        description={`${customer.phone}${customer.email ? ` · ${customer.email}` : ""}`}
        action={
          <Link
            href="/dashboard/customers"
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-100"
          >
            Back to customers
          </Link>
        }
      />

      <Card>
        <CardHeader title="Profile" />
        <dl className="grid gap-4 px-5 py-4 sm:grid-cols-4">
          <Detail label="Phone" value={customer.phone} />
          <Detail label="Email" value={customer.email ?? "—"} />
          <Detail
            label="Date of birth"
            value={
              customer.date_of_birth
                ? `${formatDate(customer.date_of_birth)}${age !== null ? ` (${age})` : ""}`
                : "—"
            }
          />
          <Detail label="Customer since" value={formatDate(customer.created_at)} />
        </dl>
        {customer.notes ? (
          <div className="border-t border-ink-200 px-5 py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Notes</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">{customer.notes}</p>
          </div>
        ) : null}
        {canManage ? (
          <div className="border-t border-ink-200 px-5 py-4">
            <CustomerForm customer={customer} />
          </div>
        ) : null}
      </Card>

      {canManage ? (
        <>
          <Card>
            <CardHeader
              title="Loyalty"
              description="Held as a currency balance, not a point count. Earned credit is spendable from the next visit."
            />
            <div className="px-5 py-4">
              <p className="text-3xl font-semibold tabular-nums text-ink-900">
                {formatMoney(Number(loyaltyBalance ?? 0), session.salon.currency)}
              </p>
              <p className="mt-1 text-xs text-ink-500">
                Every movement below is a ledger entry; the balance is their sum.
              </p>
            </div>
            {((ledger ?? []) as LoyaltyTransactionRow[]).length > 0 ? (
              <ul className="divide-y divide-ink-200 border-t border-ink-200">
                {((ledger ?? []) as LoyaltyTransactionRow[]).map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-2 px-5 py-2 text-sm"
                  >
                    <span className="text-ink-600">
                      {LEDGER_LABEL[entry.type]}
                      <span className="ml-2 text-xs text-ink-400">
                        {formatDateTime(entry.created_at)}
                      </span>
                    </span>
                    <span
                      className={
                        Number(entry.amount) >= 0
                          ? "tabular-nums text-emerald-700"
                          : "tabular-nums text-red-600"
                      }
                    >
                      {Number(entry.amount) >= 0 ? "+" : "−"}
                      {formatMoney(Math.abs(Number(entry.amount)), session.salon.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Receipts" description="Most recent 20." />
            {((receipts ?? []) as ReceiptRow[]).length === 0 ? (
              <EmptyState>No receipts yet.</EmptyState>
            ) : (
              <ul className="divide-y divide-ink-200">
                {((receipts ?? []) as ReceiptRow[]).map((receipt) => (
                  <li key={receipt.id}>
                    <Link
                      href={`/dashboard/pos/${receipt.id}`}
                      className="flex items-center justify-between gap-2 px-5 py-2.5 hover:bg-ink-50"
                    >
                      <span className="text-sm text-ink-800">
                        <span className="tabular-nums">#{receipt.receipt_number}</span>
                        <span className="ml-2 text-xs text-ink-500">
                          {formatDateTime(receipt.created_at)}
                        </span>
                        {receipt.status === "voided" ? (
                          <Badge tone="danger">Voided</Badge>
                        ) : null}
                      </span>
                      <span
                        className={
                          receipt.status === "voided"
                            ? "text-sm tabular-nums text-ink-400 line-through"
                            : "text-sm font-medium tabular-nums text-ink-900"
                        }
                      >
                        {formatMoney(receipt.total, session.salon.currency)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}

      <Card>
        <CardHeader
          title="Visits"
          description={
            session.profile.role === "staff"
              ? "Your own appointments with this customer."
              : "Booking history for this customer."
          }
        />
        {visits.length === 0 ? (
          <EmptyState>No appointments yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200">
            {visits.slice(0, 20).map((visit) => (
              <li key={visit.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                <span className="text-sm text-ink-800">
                  {formatDayLabel(instantToSalonDate(visit.starts_at, timeZone))}{" "}
                  <span className="tabular-nums text-ink-500">
                    {instantToSalonTime(visit.starts_at, timeZone)}
                  </span>{" "}
                  &middot; {serviceById.get(visit.service_id) ?? "Treatment"}
                  {visit.is_walk_in ? (
                    <span className="ml-2 text-xs text-amber-700">walk-in</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-ink-500">
                    {formatMoney(visit.price_at_booking, session.salon.currency)}
                  </span>
                  <Badge tone={VISIT_TONE[visit.status]}>{VISIT_LABEL[visit.status]}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Consent &amp; medical intake"
          description="One record per visit. Signed records cannot be edited — collect a new one if anything changes."
        />
        {signedForms.length === 0 ? (
          <EmptyState>
            {session.profile.role === "staff"
              ? "No consent forms that you collected for this customer."
              : "No consent forms recorded yet."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200">
            {signedForms.map((form) => {
              const formResponses = responsesByForm.get(form.id) ?? [];
              return (
                <li key={form.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-900">
                      {form.service_id ? (
                        <span>{serviceById.get(form.service_id) ?? "Treatment"}</span>
                      ) : (
                        <span>General consent</span>
                      )}
                      <Badge tone="success">Signed</Badge>
                    </p>
                    <span className="text-xs text-ink-500">
                      {formatDateTime(form.signed_at)} &middot; collected by{" "}
                      {form.collected_by
                        ? (nameById.get(form.collected_by) ?? "a former team member")
                        : "a former team member"}
                    </span>
                  </div>

                  {formResponses.length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {formResponses.map((response) => (
                        <li key={response.id} className="text-xs text-ink-600">
                          <span className={response.checked ? "text-emerald-700" : "text-red-600"}>
                            {response.checked ? "✓" : "✗"}
                          </span>{" "}
                          {response.label}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {form.medical_history || form.allergies ? (
                    <div className="mt-3 grid gap-3 rounded-lg bg-ink-50 p-3 sm:grid-cols-2">
                      {form.medical_history ? (
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                            Medical history
                          </p>
                          <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-700">
                            {form.medical_history}
                          </p>
                        </div>
                      ) : null}
                      {form.allergies ? (
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                            Allergies
                          </p>
                          <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-700">
                            {form.allergies}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {(attachmentsByForm.get(form.id) ?? []).length > 0 ? (
                    <div className="mt-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                        Attachments
                      </p>
                      <ul className="mt-1 divide-y divide-ink-100">
                        {(attachmentsByForm.get(form.id) ?? []).map((attachment) => (
                          <AttachmentLink
                            key={attachment.id}
                            id={attachment.id}
                            fileName={attachment.file_name}
                            mimeType={attachment.mime_type}
                            sizeBytes={attachment.size_bytes}
                          />
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {form.signature_path ? (
                    <div className="mt-3">
                      <SignatureViewer formId={form.id} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Collect a new consent form"
          description="Recorded against you as the collecting team member."
        />
        <div className="px-5 py-4">
          <ConsentForm
            customerId={customer.id}
            services={(services ?? []) as ServiceRow[]}
            templates={(templates ?? []) as ConsentTemplateRow[]}
            itemsByTemplate={itemsByTemplate}
            appointments={attachable}
          />
        </div>
      </Card>
    </>
  );
}

const LEDGER_LABEL: Record<LoyaltyTransactionRow["type"], string> = {
  earn: "Earned",
  redeem: "Redeemed",
  void_reversal: "Adjusted (receipt voided)",
};

const VISIT_TONE: Record<AppointmentStatus, "brand" | "success" | "warning" | "danger" | "neutral"> = {
  booked: "neutral",
  confirmed: "brand",
  completed: "success",
  cancelled: "danger",
  no_show: "warning",
};

const VISIT_LABEL: Record<AppointmentStatus, string> = {
  booked: "Booked",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink-800">{value}</dd>
    </div>
  );
}
