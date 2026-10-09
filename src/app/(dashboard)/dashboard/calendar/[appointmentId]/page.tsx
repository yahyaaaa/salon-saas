import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { STATUS_LABEL, STATUS_TONE } from "../page";
import { AppointmentActions } from "../appointment-actions";
import { completeAndCheckOutAction } from "../actions";
import { ServicesEditor } from "./services-editor";
import { RecordPaymentForm, RefundPaymentForm } from "./payment-form";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/format";
import {
  formatInstantInSalon,
  formatLongDayLabel,
  instantToSalonDate,
  instantToSalonTime,
  salonToday,
} from "@/lib/time";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
} from "@/components/ui";
import type {
  AppointmentBalance,
  AppointmentRow,
  AppointmentServiceRow,
  CustomerRow,
  PaymentKind,
  PaymentRow,
  ProfileRow,
  ReceiptRow,
  ServiceRow,
  TeamMemberRow,
} from "@/lib/types/database";

export const metadata: Metadata = { title: "Appointment" };

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  bank_transfer: "Bank transfer",
  other: "Other",
};

const KIND_LABEL: Record<PaymentKind, string> = {
  deposit: "Advance",
  settlement: "At checkout",
  refund: "Refund",
};

export default async function AppointmentPage({
  params,
}: PageProps<"/dashboard/calendar/[appointmentId]">) {
  const { appointmentId } = await params;
  const session = await requireSession();
  const supabase = await createClient();

  const timeZone = session.salon.timezone;
  const currency = session.salon.currency;
  const isFrontDesk =
    session.profile.role === "owner" || session.profile.role === "receptionist";
  const isOwner = session.profile.role === "owner";

  // RLS decides visibility: a therapist reaching another therapist's
  // appointment gets nothing back and falls through to notFound().
  const { data: appointment } = await supabase
    .from("appointments")
    .select("*")
    .eq("id", appointmentId)
    .maybeSingle();

  if (!appointment) notFound();
  const appt = appointment as AppointmentRow;

  const [
    { data: lines },
    { data: customer },
    { data: team },
    { data: services },
    { data: receipts },
    { data: balanceRows },
    { data: payments },
  ] = await Promise.all([
    supabase
      .from("appointment_services")
      .select("*")
      .eq("appointment_id", appointmentId)
      .order("sort_order"),
    supabase.from("customers").select("*").eq("id", appt.customer_id).maybeSingle(),
    // The roster performs the work; the logins below only record who acted.
    supabase.from("team_members").select("*").eq("is_active", true).order("full_name"),
    isFrontDesk
      ? supabase.from("services").select("*").eq("is_active", true).order("name")
      : Promise.resolve({ data: [] as ServiceRow[] }),
    supabase.from("receipts").select("*").eq("appointment_id", appointmentId),
    supabase.rpc("appointment_balance", { p_appointment_id: appointmentId }),
    // The ledger is front-desk only by policy; a therapist simply gets nothing.
    supabase
      .from("payments")
      .select("*")
      .eq("appointment_id", appointmentId)
      .order("paid_at"),
  ]);

  const roster = (team ?? []) as TeamMemberRow[];
  const nameById = new Map<string, string>();
  for (const p of roster) nameById.set(p.id, p.full_name);

  /*
   * Who DID things, as opposed to who performs services: the person who took
   * the booking, recorded a payment, or issued the receipt. Those are logins,
   * and since the Team/User split they are a different set of ids entirely.
   */
  const { data: logins } = await supabase.from("profiles").select("id, full_name, email");
  const actorName = new Map<string, string>();
  for (const p of (logins ?? []) as Pick<ProfileRow, "id" | "full_name" | "email">[]) {
    actorName.set(p.id, p.full_name || p.email);
  }

  const bookedLines = (lines ?? []) as AppointmentServiceRow[];
  const paymentRows = (payments ?? []) as PaymentRow[];
  const balance = ((balanceRows ?? []) as AppointmentBalance[])[0];
  const receipt = ((receipts ?? []) as ReceiptRow[]).find((r) => r.status === "issued");
  const voidedReceipts = ((receipts ?? []) as ReceiptRow[]).filter(
    (r) => r.status === "voided",
  );

  const due = Number(balance?.amount_due ?? appt.price_at_booking);
  const paid = Number(balance?.amount_paid ?? 0);
  const outstanding = Number(balance?.balance ?? due);

  const localDate = instantToSalonDate(appt.starts_at, timeZone);
  const localStart = instantToSalonTime(appt.starts_at, timeZone);
  const localEnd = instantToSalonTime(appt.ends_at, timeZone);

  const editable = appt.status === "booked" || appt.status === "confirmed";
  const payable = editable || appt.status === "completed";

  /*
   * The payment state, which is deliberately NOT the service state. A visit can
   * be paid for in full before it happens, and completed while still owing.
   */
  const paymentLabel =
    paid <= 0 ? "Unpaid" : outstanding > 0.005 ? "Part-paid" : outstanding < -0.005 ? "Overpaid" : "Paid";
  const paymentTone =
    paymentLabel === "Paid" ? "success" : paymentLabel === "Unpaid" ? "danger" : "warning";

  return (
    <>
      <PageHeader
        title={`${localStart}–${localEnd}`}
        description={`${formatLongDayLabel(localDate)} · ${
          nameById.get(appt.staff_id) ?? "Team member"
        } · times in ${timeZone}`}
        action={
          <Link
            href={`/dashboard/calendar?view=day&date=${localDate}`}
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-100"
          >
            Back to the diary
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[appt.status]}>{STATUS_LABEL[appt.status]}</Badge>
        {appt.is_walk_in ? <Badge tone="warning">Walk-in</Badge> : null}
        {isFrontDesk ? <Badge tone={paymentTone}>{paymentLabel}</Badge> : null}
      </div>

      {appt.resolution_reason ? (
        <Alert tone="error">
          {STATUS_LABEL[appt.status]}: {appt.resolution_reason}
        </Alert>
      ) : null}

      {/* ---- what was booked ---------------------------------------- */}
      <Card>
        <CardHeader
          title="The booking"
          description={`Booked ${formatInstantInSalon(appt.created_at, timeZone)}${
            appt.created_by ? ` by ${actorName.get(appt.created_by) ?? "a colleague"}` : ""
          }.`}
        />

        <dl className="grid gap-px border-b border-ink-200 bg-ink-200 sm:grid-cols-3">
          <Fact label="Customer">
            <Link
              href={`/dashboard/customers/${appt.customer_id}`}
              className="text-brand-700 hover:underline"
            >
              {(customer as CustomerRow | null)?.full_name ?? "Customer"}
            </Link>
          </Fact>
          <Fact label="Service date">{formatLongDayLabel(localDate)}</Fact>
          <Fact label="Booked on">{formatInstantInSalon(appt.created_at, timeZone)}</Fact>
        </dl>

        {bookedLines.length === 0 ? (
          <EmptyState>No services recorded on this booking.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="px-5 py-2 font-medium">Service</th>
                <th className="px-5 py-2 text-right font-medium">Qty</th>
                <th className="px-5 py-2 text-right font-medium">Price</th>
                <th className="px-5 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {bookedLines.map((line) => (
                <tr key={line.id}>
                  <td className="px-5 py-2 text-ink-800">{line.service_name}</td>
                  <td className="px-5 py-2 text-right tabular-nums text-ink-600">
                    {line.quantity}
                  </td>
                  <td className="px-5 py-2 text-right tabular-nums text-ink-600">
                    {formatMoney(line.unit_price, currency)}
                  </td>
                  <td className="px-5 py-2 text-right tabular-nums text-ink-800">
                    {formatMoney(Number(line.unit_price) * line.quantity, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <dl className="ml-auto w-full max-w-sm space-y-1.5 px-5 py-4 text-sm">
          <Row label="Services subtotal" value={formatMoney(appt.services_subtotal, currency)} />
          {Number(appt.discount_amount) > 0 ? (
            <Row
              label="Discount"
              value={`− ${formatMoney(appt.discount_amount, currency)}`}
              tone="good"
            />
          ) : null}
          {appt.quoted_total !== null ? (
            <Row label="Quoted price" value={formatMoney(appt.quoted_total, currency)} />
          ) : null}
          <div className="flex items-center justify-between border-t border-ink-200 pt-2 text-base font-semibold text-ink-900">
            <dt>Agreed at booking</dt>
            <dd className="tabular-nums">{formatMoney(appt.price_at_booking, currency)}</dd>
          </div>
        </dl>

        {appt.notes ? (
          <p className="border-t border-ink-200 px-5 py-3 text-sm text-ink-600">
            <span className="font-medium">Note:</span> {appt.notes}
          </p>
        ) : null}
      </Card>

      {/* ---- the bill ------------------------------------------------ */}
      {isFrontDesk ? (
        <Card>
          <CardHeader
            title="Payment"
            description={
              receipt
                ? "The receipt is what is owed; the ledger below is what was actually received."
                : "No receipt yet. Anything taken now is an advance against the agreed price."
            }
          />

          <dl className="grid gap-px border-b border-ink-200 bg-ink-200 sm:grid-cols-3">
            <Fact label={receipt ? "Billed" : "Agreed price"}>
              {formatMoney(due, currency)}
            </Fact>
            <Fact label="Paid so far">{formatMoney(paid, currency)}</Fact>
            <Fact label={outstanding < 0 ? "Owed back" : "Outstanding"} strong>
              {formatMoney(Math.abs(outstanding), currency)}
            </Fact>
          </dl>

          {receipt ? (
            <p className="border-b border-ink-200 px-5 py-3 text-sm text-ink-600">
              Billed on receipt{" "}
              <Link href={`/dashboard/pos/${receipt.id}`} className="text-brand-700 hover:underline">
                #{receipt.receipt_number}
              </Link>{" "}
              for {formatMoney(receipt.total, currency)}.
            </p>
          ) : null}

          {voidedReceipts.length > 0 ? (
            <p className="border-b border-ink-200 px-5 py-3 text-xs text-ink-500">
              {voidedReceipts.length} voided receipt
              {voidedReceipts.length === 1 ? "" : "s"} on this visit:{" "}
              {voidedReceipts.map((r, i) => (
                <span key={r.id}>
                  {i > 0 ? ", " : ""}
                  <Link href={`/dashboard/pos/${r.id}`} className="text-brand-700 hover:underline">
                    #{r.receipt_number}
                  </Link>
                </span>
              ))}
            </p>
          ) : null}

          {paymentRows.length === 0 ? (
            <EmptyState>Nothing paid yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-ink-200">
              {paymentRows.map((payment) => (
                <li
                  key={payment.id}
                  className="flex flex-wrap items-start justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-ink-900">
                      <span
                        className={
                          Number(payment.amount) < 0
                            ? "font-semibold tabular-nums text-red-700"
                            : "font-semibold tabular-nums text-ink-900"
                        }
                      >
                        {formatMoney(payment.amount, currency)}
                      </span>
                      <Badge tone={payment.kind === "refund" ? "danger" : "neutral"}>
                        {KIND_LABEL[payment.kind]}
                      </Badge>
                      <span className="text-xs text-ink-500">
                        {METHOD_LABEL[payment.method] ?? payment.method}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {formatInstantInSalon(payment.paid_at, timeZone)}
                      {payment.recorded_by
                        ? ` · ${actorName.get(payment.recorded_by) ?? "a colleague"}`
                        : ""}
                    </p>
                    {payment.note ? (
                      <p className="mt-1 text-xs text-ink-500">{payment.note}</p>
                    ) : null}
                  </div>

                  {isOwner && payment.kind !== "refund" ? (
                    <RefundPaymentForm
                      paymentId={payment.id}
                      appointmentId={appointmentId}
                      amount={Number(payment.amount)}
                      currency={currency}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {payable && outstanding > 0.005 ? (
            <div className="border-t border-ink-200 px-5 py-4">
              <h3 className="mb-3 text-sm font-semibold text-ink-900">Take a payment</h3>
              <RecordPaymentForm
                appointmentId={appointmentId}
                outstanding={outstanding}
                currency={currency}
                today={salonToday(timeZone)}
              />
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ---- what can still be done ---------------------------------- */}
      {isFrontDesk ? (
        <Card>
          <CardHeader
            title="Actions"
            description="Completing a visit offers the till; it does not require it. A completed visit can still be owed for."
          />
          <div className="flex flex-wrap items-start gap-2 px-5 py-4">
            {editable ? (
              <form action={completeAndCheckOutAction}>
                <input type="hidden" name="appointmentId" value={appointmentId} />
                <Button type="submit">Complete &amp; take payment</Button>
              </form>
            ) : null}

            {appt.status === "completed" && !receipt ? (
              <Link
                href={`/dashboard/pos?appointment=${appointmentId}`}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
              >
                Raise the bill
              </Link>
            ) : null}

            <AppointmentActions
              appointmentId={appointmentId}
              status={appt.status}
              staffId={appt.staff_id}
              date={localDate}
              time={localStart}
              therapists={roster.map((m) => ({ id: m.id, name: m.full_name }))}
            />
          </div>
        </Card>
      ) : null}

      {/* ---- editing -------------------------------------------------- */}
      {isFrontDesk && editable ? (
        <Card>
          <CardHeader
            title="Change the services or the price"
            description="Available until the visit is finished or billed. The slot length follows the services, and the new price cannot fall below what has already been paid."
          />
          <div className="px-5 py-4">
            <ServicesEditor
              appointmentId={appointmentId}
              services={(services ?? []) as ServiceRow[]}
              booked={bookedLines}
              discount={Number(appt.discount_amount)}
              quotedTotal={appt.quoted_total === null ? null : Number(appt.quoted_total)}
              currency={currency}
            />
          </div>
        </Card>
      ) : null}
    </>
  );
}

function Fact({
  label,
  children,
  strong = false,
}: {
  label: string;
  children: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="bg-white px-5 py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd
        className={
          strong
            ? "mt-0.5 text-base font-semibold tabular-nums text-ink-900"
            : "mt-0.5 text-sm text-ink-800"
        }
      >
        {children}
      </dd>
    </div>
  );
}

function Row({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: string;
  tone?: "normal" | "good";
}) {
  return (
    <div className="flex items-center justify-between text-ink-600">
      <dt>{label}</dt>
      <dd className={tone === "good" ? "tabular-nums text-emerald-700" : "tabular-nums"}>
        {value}
      </dd>
    </div>
  );
}
