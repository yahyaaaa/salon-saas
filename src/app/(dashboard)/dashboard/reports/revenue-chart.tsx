"use client";

import { useState } from "react";

import { formatMoney } from "@/lib/format";
import { formatDayLabel } from "@/lib/time";
import type { ReportGranularity, RevenueBucket } from "@/lib/types/database";

/**
 * Revenue over time.
 *
 * One series, so there is no legend — the card title names it. Magnitude over
 * ordered time buckets, which is a bar chart's job: the gaps between bars keep
 * "no sales that day" visually distinct from "a small day", which a line would
 * smooth over.
 *
 * Only two values are labelled directly (the best bucket and the latest);
 * everything else is on hover, so the axis stays readable.
 */
export function RevenueChart({
  buckets,
  currency,
  granularity,
}: {
  buckets: RevenueBucket[];
  currency: string;
  granularity: ReportGranularity;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const values = buckets.map((b) => Number(b.revenue));
  const max = Math.max(...values, 1);
  const peakIndex = values.indexOf(Math.max(...values));
  const lastIndex = buckets.length - 1;

  function label(bucket: string) {
    if (granularity === "month") {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: "UTC",
        month: "short",
        year: "2-digit",
      }).format(new Date(`${bucket}T12:00:00.000Z`));
    }
    return formatDayLabel(bucket);
  }

  return (
    <figure className="m-0">
      <div className="relative">
        {/* Recessive gridlines at quarter steps. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col justify-between">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="border-t border-ink-100" />
          ))}
        </div>

        <ul className="relative flex h-56 items-end gap-0.5">
          {buckets.map((bucket, index) => {
            const value = Number(bucket.revenue);
            const height = (value / max) * 100;
            const isHighlighted = index === peakIndex || index === lastIndex;

            return (
              <li
                key={bucket.bucket}
                className="group relative flex h-full flex-1 items-end"
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(index)}
                onBlur={() => setHovered(null)}
              >
                <button
                  type="button"
                  className="w-full rounded-t-[4px] bg-brand-500 transition-colors hover:bg-brand-600 focus:bg-brand-600 focus:outline-none"
                  style={{ height: `${Math.max(height, value > 0 ? 1.5 : 0)}%` }}
                  aria-label={`${label(bucket.bucket)}: ${formatMoney(value, currency)} from ${bucket.receipt_count} receipts`}
                />

                {hovered === index ? (
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-40 -translate-x-1/2 rounded-lg border border-ink-200 bg-white p-2.5 text-left shadow-lg">
                    <p className="text-xs font-semibold text-ink-900">
                      {label(bucket.bucket)}
                    </p>
                    <p className="mt-1 text-sm font-semibold tabular-nums text-ink-900">
                      {formatMoney(value, currency)}
                    </p>
                    <dl className="mt-1 space-y-0.5 text-xs text-ink-500">
                      <Row label="Receipts" value={String(bucket.receipt_count)} />
                      {Number(bucket.discounts) > 0 ? (
                        <Row
                          label="Discounts"
                          value={formatMoney(bucket.discounts, currency)}
                        />
                      ) : null}
                      {Number(bucket.loyalty_redeemed) > 0 ? (
                        <Row
                          label="Loyalty used"
                          value={formatMoney(bucket.loyalty_redeemed, currency)}
                        />
                      ) : null}
                    </dl>
                  </div>
                ) : null}

                {isHighlighted && hovered === null && value > 0 ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 text-center text-[10px] font-medium tabular-nums text-ink-500"
                    style={{ bottom: `calc(${Math.max(height, 1.5)}% + 2px)` }}
                  >
                    {formatMoney(value, currency)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-2 flex justify-between text-xs text-ink-400">
        <span>{label(buckets[0].bucket)}</span>
        {buckets.length > 1 ? <span>{label(buckets[lastIndex].bucket)}</span> : null}
      </div>

      <figcaption className="sr-only">
        Revenue per {granularity}. The full figures are in the table below.
      </figcaption>

      {/* Never colour-alone: the same data, readable by a screen reader. */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-ink-500 hover:text-ink-700">
          Show as a table
        </summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="py-1.5 font-medium">Period</th>
                <th className="py-1.5 text-right font-medium">Receipts</th>
                <th className="py-1.5 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {buckets.map((bucket) => (
                <tr key={bucket.bucket}>
                  <td className="py-1.5 text-ink-700">{label(bucket.bucket)}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink-600">
                    {bucket.receipt_count}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-ink-800">
                    {formatMoney(bucket.revenue, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
