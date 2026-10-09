"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import { checkoutAction, loyaltyBalanceAction, type PosFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Button, Card, CardHeader, Field, Input, Select } from "@/components/ui";
import { CustomerPicker } from "@/components/customer-picker";
import { ServicePicker } from "@/components/service-picker";
import { toPickable } from "@/lib/services";
import { formatMoney } from "@/lib/format";
import type { DealRow, ServiceRow } from "@/lib/types/database";

interface BasketLine {
  key: string;
  serviceId: string;
  staffId: string;
  quantity: number;
}

/**
 * The till.
 *
 * The figures shown here are an ESTIMATE for the person at the desk. They are
 * recomputed from the catalogue by `create_receipt()` in Postgres, and it is
 * that calculation which lands on the receipt. If the two ever disagree, the
 * server is right — which is why nothing below is submitted as a price.
 */
/**
 * A visit being brought to the till from the diary.
 *
 * `deposit` is what has already been paid against it. The till collects the
 * BALANCE -- `create_receipt()` nets the deposit off server-side -- so the
 * figures shown here have to do the same or the desk would ask for the whole
 * bill twice.
 */
export interface CheckoutPrefill {
  appointmentId: string;
  customerId: string;
  customerName: string;
  /** "Name — phone", as the picker shows a chosen customer. */
  customerLabel: string;
  deposit: number;
  lines: { serviceId: string; staffId: string; quantity: number }[];
}

export function Till({
  services,
  therapists,
  deals,
  servicesByDeal,
  currency,
  prefill,
}: {
  services: ServiceRow[];
  therapists: { id: string; name: string }[];
  deals: DealRow[];
  servicesByDeal: Record<string, string[]>;
  currency: string;
  prefill?: CheckoutPrefill;
}) {
  const [state, formAction] = useActionState<PosFormState, FormData>(checkoutAction, {});

  // React clears an uncontrolled form once its action resolves, and the basket
  // itself lives in state, so a refused sale is re-seeded from what was rung up
  // rather than having to be entered again.
  const was = (name: string, fallback = "") => state.values?.[name] ?? fallback;

  const [customerId, setCustomerId] = useState(was("customerId", prefill?.customerId ?? ""));
  const [balance, setBalance] = useState(0);
  const [lines, setLines] = useState<BasketLine[]>(() => {
    // A rejected sale takes precedence: it carries what the desk had just
    // typed, which is newer than whatever the booking said.
    try {
      const restored = JSON.parse(was("lines", "[]")) as Omit<BasketLine, "key">[];
      if (restored.length > 0) {
        return restored.map((line, index) => ({ ...line, key: `restored-${index}` }));
      }
    } catch {
      /* fall through to the booking */
    }
    return (prefill?.lines ?? []).map((line, index) => ({
      ...line,
      key: `booked-${index}`,
    }));
  });
  const [dealId, setDealId] = useState(was("dealId"));
  const [redeem, setRedeem] = useState(was("loyaltyRedeem", "0"));
  const [paymentMethod, setPaymentMethod] = useState(was("paymentMethod", "cash"));
  const [cash, setCash] = useState(was("cashAmount", "0"));
  const [card, setCard] = useState(was("cardAmount", "0"));
  const [transfer, setTransfer] = useState(was("transferAmount", "0"));

  const serviceById = useMemo(
    () => new Map(services.map((s) => [s.id, s])),
    [services],
  );

  // Fetch the balance when the customer changes. Server-side, through RLS.
  // Clearing on deselect happens in the change handler, not here, so this
  // effect only ever reacts to a fetch completing.
  useEffect(() => {
    if (!customerId) return;

    let cancelled = false;
    loyaltyBalanceAction(customerId).then((value) => {
      if (!cancelled) setBalance(value);
    });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  function chooseCustomer(nextId: string) {
    setCustomerId(nextId);
    // Drop the previous customer's balance immediately rather than showing it
    // against the new one while the fetch is in flight.
    setBalance(0);
    setRedeem("0");
  }

  const pickable = useMemo(() => toPickable(services), [services]);

  function addServices(ids: string[]) {
    setLines((current) => {
      const next = [...current];
      for (const id of ids) {
        // The same service twice means two of them, not two rows to scroll past.
        const existing = next.find((l) => l.serviceId === id);
        if (existing) existing.quantity = Math.min(99, existing.quantity + 1);
        else
          next.push({
            key: `${id}-${Date.now()}-${next.length}`,
            serviceId: id,
            staffId: therapists[0]?.id ?? "",
            quantity: 1,
          });
      }
      return next;
    });
  }

  function updateLine(key: string, patch: Partial<BasketLine>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((l) => l.key !== key));
  }

  /* ---- estimate only; the server recomputes all of this ---- */
  const gross = lines.reduce((sum, line) => {
    const service = serviceById.get(line.serviceId);
    return sum + (service ? Number(service.price) * line.quantity : 0);
  }, 0);

  const deal = deals.find((d) => d.id === dealId);
  const eligibleGross = deal
    ? lines.reduce((sum, line) => {
        const service = serviceById.get(line.serviceId);
        const eligible = (servicesByDeal[deal.id] ?? []).includes(line.serviceId);
        return sum + (service && eligible ? Number(service.price) * line.quantity : 0);
      }, 0)
    : 0;

  let discount = 0;
  if (deal && eligibleGross > 0) {
    if (deal.deal_type === "percentage") {
      discount = Math.round(eligibleGross * Number(deal.value)) / 100;
    } else if (deal.deal_type === "fixed_amount") {
      discount = Math.min(Number(deal.value), eligibleGross);
    } else {
      discount = Math.max(0, eligibleGross - Number(deal.value));
    }
  }

  const bill = Math.max(0, Math.round((gross - discount) * 100) / 100);
  const maxRedeem = Math.min(balance, bill);
  const redeemValue = Math.min(Math.max(Number(redeem) || 0, 0), maxRedeem);
  const total = Math.round((bill - redeemValue) * 100) / 100;

  // What the customer has already handed over for this visit, and therefore
  // what is left to take now. Mirrors create_receipt(): nothing is collected
  // when the deposit has overtaken the bill.
  const deposit =
    prefill && customerId === prefill.customerId ? prefill.deposit : 0;
  const dueNow = Math.max(0, Math.round((total - deposit) * 100) / 100);
  const overpaid = Math.round((deposit - total) * 100) / 100;

  const linesJson = JSON.stringify(
    lines
      .filter((l) => l.serviceId && l.staffId)
      .map((l) => ({
        serviceId: l.serviceId,
        staffId: l.staffId,
        quantity: l.quantity,
      })),
  );

  const splitTotal =
    Math.round(
      ((Number(cash) || 0) + (Number(card) || 0) + (Number(transfer) || 0)) * 100,
    ) / 100;
  const splitMismatch = paymentMethod === "split" && splitTotal !== dueNow;

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="lines" value={linesJson} />
      <input type="hidden" name="loyaltyRedeem" value={redeemValue} />
      {/*
        The customer stays editable -- the wrong booking can be opened, and a
        locked field would leave no way out. But changing it away from the
        booking's own customer means this sale is no longer that visit, so the
        link is dropped rather than letting create_receipt() refuse it with
        "that appointment belongs to a different customer".
      */}
      {prefill && customerId === prefill.customerId ? (
        <input type="hidden" name="appointmentId" value={prefill.appointmentId} />
      ) : null}

      {prefill ? (
        <Alert tone="info">
          Checking out {prefill.customerName}&rsquo;s booking. The services and the
          customer are filled in from the diary, and anything already paid is taken
          off what the till asks for.
        </Alert>
      ) : null}

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Card>
        <CardHeader title="Customer" />
        <div className="space-y-4 px-5 py-4">
          {/*
            The booking's customer is already known, so the desk should not
            have to search for them again. `was()` reads only from a REJECTED
            sale, which is empty on a fresh "Raise the bill" -- the prefill is
            the fallback. Getting this wrong is invisible in the loyalty
            balance, which is driven by the Till's own state and so looked
            right while the picker sat empty.
          */}
          <CustomerPicker
            idPrefix="pos"
            errors={state.errors ?? {}}
            defaultMode={was("customerMode") === "new" ? "new" : "existing"}
            defaultCustomerId={was("customerId", prefill?.customerId ?? "")}
            defaultCustomerLabel={prefill?.customerLabel ?? ""}
            defaultName={was("newCustomerName")}
            defaultPhone={was("newCustomerPhone")}
            onCustomerChange={chooseCustomer}
          />

          {customerId ? (
            <div className="rounded-lg bg-ink-50 px-3 py-2">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                Loyalty balance
              </p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-ink-900">
                {formatMoney(balance, currency)}
              </p>
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Services"
          description="Each line records who performed it — that is what payroll reads."
        />
        <div className="px-5 py-4">
          <ServicePicker
            services={pickable}
            currency={currency}
            onAdd={addServices}
            label="Add to this sale"
          />
          {state.errors?.lines ? (
            <p className="mt-1 text-xs font-medium text-red-600">{state.errors.lines}</p>
          ) : null}
        </div>

        {lines.length === 0 ? (
          <p className="px-5 pb-6 text-center text-sm text-ink-500">
            Nothing in the basket yet.
          </p>
        ) : (
          <ul className="divide-y divide-ink-200 border-t border-ink-200">
            {lines.map((line) => {
              const service = serviceById.get(line.serviceId);
              return (
                <li
                  key={line.key}
                  className="grid gap-3 px-5 py-3 sm:grid-cols-[2fr_2fr_auto_auto_auto] sm:items-end"
                >
                  <div className="pb-2">
                    <p className="text-sm font-medium text-ink-900">
                      {service?.name ?? "Service"}
                    </p>
                    <p className="text-xs text-ink-400">{service?.category}</p>
                  </div>

                  <Field label="Performed by" htmlFor={`staff-${line.key}`}>
                    <Select
                      id={`staff-${line.key}`}
                      value={line.staffId}
                      onChange={(event) => updateLine(line.key, { staffId: event.target.value })}
                    >
                      {therapists.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field label="Qty" htmlFor={`qty-${line.key}`}>
                    <Input
                      id={`qty-${line.key}`}
                      type="number"
                      min={1}
                      max={99}
                      value={line.quantity}
                      onChange={(event) =>
                        updateLine(line.key, { quantity: Number(event.target.value) || 1 })
                      }
                      className="w-20"
                    />
                  </Field>

                  <p className="pb-2 text-sm tabular-nums text-ink-700">
                    {formatMoney(service ? Number(service.price) * line.quantity : 0, currency)}
                  </p>

                  <div className="pb-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeLine(line.key)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Discounts and payment" />
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Deal" htmlFor="pos-deal" error={state.errors?.dealId}>
              <Select
                id="pos-deal"
                name="dealId"
                value={dealId}
                onChange={(event) => setDealId(event.target.value)}
              >
                <option value="">No deal</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Redeem loyalty"
              htmlFor="pos-redeem"
              error={state.errors?.loyaltyRedeem}
              hint={`Up to ${formatMoney(maxRedeem, currency)} — the lower of the balance and the bill.`}
            >
              <div className="flex items-center gap-2">
                <Input
                  id="pos-redeem"
                  type="number"
                  step="0.01"
                  min="0"
                  max={maxRedeem}
                  value={redeem}
                  onChange={(event) => setRedeem(event.target.value)}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setRedeem(String(maxRedeem))}
                  disabled={maxRedeem <= 0}
                >
                  Max
                </Button>
              </div>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Payment method" htmlFor="pos-method" error={state.errors?.paymentMethod}>
              <Select
                id="pos-method"
                name="paymentMethod"
                value={paymentMethod}
                onChange={(event) => setPaymentMethod(event.target.value)}
              >
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="split">Split</option>
              </Select>
            </Field>

            {paymentMethod === "split" ? (
              <>
                <Field label="Cash" htmlFor="pos-cash" error={state.errors?.cashAmount}>
                  <Input
                    id="pos-cash"
                    name="cashAmount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={cash}
                    onChange={(event) => setCash(event.target.value)}
                  />
                </Field>
                <Field label="Card" htmlFor="pos-card" error={state.errors?.cardAmount}>
                  <Input
                    id="pos-card"
                    name="cardAmount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={card}
                    onChange={(event) => setCard(event.target.value)}
                  />
                </Field>
                <Field
                  label="Bank transfer"
                  htmlFor="pos-transfer"
                  error={state.errors?.transferAmount}
                >
                  <Input
                    id="pos-transfer"
                    name="transferAmount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={transfer}
                    onChange={(event) => setTransfer(event.target.value)}
                  />
                </Field>
              </>
            ) : null}
          </div>

          {splitMismatch ? (
            <Alert tone="warning">
              The split adds up to {formatMoney(splitTotal, currency)}, but the total is{" "}
              {formatMoney(dueNow, currency)}. The server will refuse this.
            </Alert>
          ) : null}

          <Field label="Notes" htmlFor="pos-notes" error={state.errors?.notes}>
            <Input
              id="pos-notes"
              name="notes"
              defaultValue={was("notes")}
              placeholder="Anything to record on the receipt"
            />
          </Field>
        </div>

        <dl className="space-y-1.5 border-t border-ink-200 bg-ink-50 px-5 py-4 text-sm">
          <Row label="Subtotal" value={formatMoney(gross, currency)} />
          {discount > 0 ? (
            <Row label={`Deal (${deal?.name})`} value={`− ${formatMoney(discount, currency)}`} />
          ) : null}
          {redeemValue > 0 ? (
            <Row label="Loyalty redeemed" value={`− ${formatMoney(redeemValue, currency)}`} />
          ) : null}
          <div className="flex items-center justify-between border-t border-ink-200 pt-2 text-base font-semibold text-ink-900">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatMoney(total, currency)}</dd>
          </div>

          {deposit > 0 ? (
            <>
              <Row label="Already paid" value={`− ${formatMoney(deposit, currency)}`} />
              <div className="flex items-center justify-between border-t border-ink-200 pt-2 text-base font-semibold text-brand-700">
                <dt>{overpaid > 0 ? "To refund" : "To collect now"}</dt>
                <dd className="tabular-nums">
                  {formatMoney(overpaid > 0 ? overpaid : dueNow, currency)}
                </dd>
              </div>
            </>
          ) : null}

          {overpaid > 0 ? (
            <p className="pt-1 text-xs text-amber-700">
              The deposit is larger than the bill. The sale will go through collecting
              nothing, and the difference shows as owed back on the appointment, where
              it can be refunded.
            </p>
          ) : null}

          <p className="pt-1 text-xs text-ink-500">
            Shown as a guide. The receipt is calculated on the server from the price list.
          </p>
        </dl>
      </Card>

      <SubmitButton pendingLabel="Taking payment...">
        {deposit > 0 ? `Take ${formatMoney(dueNow, currency)}` : "Take payment"}
      </SubmitButton>
    </form>
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
