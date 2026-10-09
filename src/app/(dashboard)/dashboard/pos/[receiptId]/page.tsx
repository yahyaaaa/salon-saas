import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { VoidReceiptForm } from "./void-form";
import { PrintButton } from "./print-button";
import { requireModule } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime, formatMoney } from "@/lib/format";
import { Alert, Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import type {
  CustomerRow,
  PaymentRow,
  ProfileRow,
  ReceiptLineItemRow,
  ReceiptRow,
  TeamMemberRow,
} from "@/lib/types/database";

export const metadata: Metadata = { title: "Receipt" };

const METHOD_LABEL = {
  cash: "Cash",
  card: "Card",
  bank_transfer: "Bank transfer",
  split: "Split",
} as const;

const PAYMENT_KIND_LABEL = {
  deposit: "Advance",
  settlement: "At checkout",
  refund: "Refund",
} as const;

export default async function ReceiptPage({ params }: PageProps<"/dashboard/pos/[receiptId]">) {
  const { receiptId } = await params;
  const session = await requireModule("pos");
  const supabase = await createClient();

  const { data: receipt } = await supabase
    .from("receipts")
    .select("*")
    .eq("id", receiptId)
    .maybeSingle();

  if (!receipt) notFound();

  const [
    { data: lines },
    { data: customer },
    { data: team },
    { data: roster },
    { data: payments },
  ] = await Promise.all([
      supabase
        .from("receipt_line_items")
        .select("*")
        .eq("receipt_id", receiptId)
        .order("sort_order"),
      supabase.from("customers").select("*").eq("id", receipt.customer_id).maybeSingle(),
      supabase.from("profiles").select("id, full_name, email"),
      // Line attribution is to the roster, which is not the same set of ids
      // as the logins above.
      supabase.from("team_members").select("id, full_name"),
      // Every payment against the VISIT, not just this receipt, so an advance
      // taken days earlier appears on the document that accounts for it.
      receipt.appointment_id
        ? supabase
            .from("payments")
            .select("*")
            .eq("appointment_id", receipt.appointment_id)
            .order("paid_at")
        : supabase.from("payments").select("*").eq("receipt_id", receiptId).order("paid_at"),
    ]);

  // Logins: who issued or voided the receipt.
  const nameById = new Map<string, string>();
  for (const p of (team ?? []) as Pick<ProfileRow, "id" | "full_name" | "email">[]) {
    nameById.set(p.id, p.full_name || p.email);
  }

  // The roster: who performed each line.
  const performerName = new Map<string, string>();
  for (const m of (roster ?? []) as Pick<TeamMemberRow, "id" | "full_name">[]) {
    performerName.set(m.id, m.full_name);
  }

  const r = receipt as ReceiptRow;
  const currency = session.salon.currency;
  const isOwner = session.profile.role === "owner";

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          title={`Receipt #${r.receipt_number}`}
          description={formatDateTime(r.created_at)}
          action={
            <div className="flex items-center gap-2">
              <PrintButton />
              <Link
                href="/dashboard/pos"
                className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-100"
              >
                Back to POS
              </Link>
            </div>
          }
        />
      </div>

      {r.status === "voided" ? (
        <div className="print:hidden">
          <Alert tone="error">
            <p className="font-medium">This receipt was voided</p>
            <p className="mt-1">
              {formatDateTime(r.voided_at)}
              {r.voided_by ? ` by ${nameById.get(r.voided_by) ?? "an owner"}` : ""} — {r.void_reason}
            </p>
            <p className="mt-1">
              The original is kept exactly as issued. The loyalty it moved has been reversed
              in the ledger.
            </p>
          </Alert>
        </div>
      ) : null}

      {/* The printable document. */}
      <Card className="print:border-0 print:shadow-none">
        <div className="space-y-5 px-6 py-6">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 pb-4">
            <div>
              <h2 className="text-base font-semibold text-ink-900">{session.salon.name}</h2>
              <p className="text-xs text-ink-500">
                {session.salon.country} &middot; {session.salon.timezone}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold tabular-nums text-ink-900">
                Receipt #{r.receipt_number}
              </p>
              <p className="text-xs text-ink-500">{formatDateTime(r.created_at)}</p>
              {r.status === "voided" ? (
                <p className="mt-1">
                  <Badge tone="danger">VOIDED</Badge>
                </p>
              ) : null}
            </div>
          </header>

          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Customer</p>
              <p className="text-ink-800">{(customer as CustomerRow | null)?.full_name ?? "—"}</p>
              <p className="text-xs text-ink-500">{(customer as CustomerRow | null)?.phone}</p>
            </div>
            <div className="sm:text-right">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Issued by</p>
              <p className="text-ink-800">
                {r.issued_by ? (nameById.get(r.issued_by) ?? "—") : "—"}
              </p>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="py-2 font-medium">Service</th>
                <th className="py-2 font-medium">Performed by</th>
                <th className="py-2 text-right font-medium">Qty</th>
                <th className="py-2 text-right font-medium">Price</th>
                <th className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {((lines ?? []) as ReceiptLineItemRow[]).map((item) => (
                <tr key={item.id}>
                  <td className="py-2 text-ink-800">{item.service_name}</td>
                  <td className="py-2 text-ink-600">
                    {item.staff_id ? (performerName.get(item.staff_id) ?? "—") : "—"}
                  </td>
                  <td className="py-2 text-right tabular-nums text-ink-600">{item.quantity}</td>
                  <td className="py-2 text-right tabular-nums text-ink-600">
                    {formatMoney(item.unit_price, currency)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-ink-800">
                    {formatMoney(item.line_total, currency)}
                    {Number(item.discount_amount) > 0 ? (
                      <span className="block text-xs text-emerald-700">
                        −{formatMoney(item.discount_amount, currency)}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="ml-auto w-full max-w-xs space-y-1.5 border-t border-ink-200 pt-3 text-sm">
            <Row label="Subtotal" value={formatMoney(r.subtotal, currency)} />
            {Number(r.discount_total) > 0 ? (
              <Row label="Discount" value={`− ${formatMoney(r.discount_total, currency)}`} />
            ) : null}
            {Number(r.loyalty_redeemed) > 0 ? (
              <Row label="Loyalty redeemed" value={`− ${formatMoney(r.loyalty_redeemed, currency)}`} />
            ) : null}
            <div className="flex items-center justify-between border-t border-ink-200 pt-2 text-base font-semibold text-ink-900">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatMoney(r.total, currency)}</dd>
            </div>
            {/*
              How the bill was settled. An advance taken before today is its
              own line, so cash + card + advance visibly adds up to the total
              rather than the printed receipt disagreeing with the money that
              crossed the counter.
            */}
            {Number(r.deposit_applied) > 0 ? (
              <Row
                label="Paid in advance"
                value={`− ${formatMoney(r.deposit_applied, currency)}`}
              />
            ) : null}
            <Row
              label={
                Number(r.deposit_applied) > 0
                  ? `Taken today (${METHOD_LABEL[r.payment_method]})`
                  : `Paid (${METHOD_LABEL[r.payment_method]})`
              }
              value={
                r.payment_method === "split"
                  ? (
                      [
                        [Number(r.cash_amount), "cash"] as const,
                        [Number(r.card_amount), "card"] as const,
                        [Number(r.transfer_amount), "transfer"] as const,
                      ]
                        .filter(([amount]) => amount > 0)
                        .map(([amount, label]) => `${formatMoney(amount, currency)} ${label}`)
                        .join(" + ") || formatMoney(0, currency)
                    )
                  : formatMoney(
                      Number(r.cash_amount) +
                        Number(r.card_amount) +
                        Number(r.transfer_amount),
                      currency,
                    )
              }
            />
          </dl>

          <div className="rounded-lg bg-ink-50 px-4 py-3 text-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Loyalty</p>
            <div className="mt-1 space-y-0.5 text-ink-700">
              <p>
                Redeemed this visit:{" "}
                <span className="tabular-nums">{formatMoney(r.loyalty_redeemed, currency)}</span>
              </p>
              <p>
                Earned this visit:{" "}
                <span className="tabular-nums">{formatMoney(r.loyalty_earned, currency)}</span>{" "}
                <span className="text-xs text-ink-500">
                  ({(Number(r.loyalty_earn_rate) * 100).toFixed(2)}% of the amount paid)
                </span>
              </p>
              <p className="text-xs text-ink-500">
                Earned credit is available on your next visit.
              </p>
            </div>
          </div>

          {r.notes ? (
            <p className="text-sm text-ink-600">
              <span className="font-medium">Note:</span> {r.notes}
            </p>
          ) : null}
        </div>
      </Card>

      {/* The money itself, outside the printable document. */}
      {((payments ?? []) as PaymentRow[]).length > 0 ? (
        <div className="print:hidden">
          <Card>
            <CardHeader
              title="Payments received"
              description={
                r.appointment_id
                  ? "Everything paid towards this visit, including advances taken before the bill was raised."
                  : "What was taken for this sale."
              }
            />
            <ul className="divide-y divide-ink-200">
              {((payments ?? []) as PaymentRow[]).map((payment) => (
                <li
                  key={payment.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm text-ink-900">
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
                        {PAYMENT_KIND_LABEL[payment.kind]}
                      </Badge>
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {formatDateTime(payment.paid_at)}
                      {payment.note ? ` · ${payment.note}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            {r.appointment_id ? (
              <div className="border-t border-ink-200 px-5 py-3">
                <Link
                  href={`/dashboard/calendar/${r.appointment_id}`}
                  className="text-sm text-brand-700 hover:underline"
                >
                  Open the appointment this settles
                </Link>
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      {isOwner && r.status === "issued" ? (
        <div className="print:hidden">
          <Card>
            <div className="px-5 py-4">
              <h3 className="text-sm font-semibold text-ink-900">Void this receipt</h3>
              <p className="mt-1 mb-3 text-sm text-ink-500">
                The receipt stays on the record marked voided, and the loyalty it moved is
                reversed. This cannot be undone.
              </p>
              <VoidReceiptForm receiptId={r.id} />
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-ink-600">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
