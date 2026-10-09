"use client";

import { useMemo, useState } from "react";

import { Button, Input, cn } from "@/components/ui";
import { formatDuration, formatMoney } from "@/lib/format";
import { groupByCategory, type PickableService } from "@/lib/services";

/**
 * Adding services to a booking or a sale.
 *
 * Two ways in, because a busy front desk has two different jobs. Typing a few
 * letters and pressing Enter is fastest when you know what you want. "All
 * services" opens the full catalogue grouped by category, where several can be
 * ticked and added in one go -- a bridal package is six taps here instead of
 * six separate rounds of "Add service".
 */
export function ServicePicker({
  services,
  currency,
  onAdd,
  label = "Add services",
}: {
  services: PickableService[];
  currency: string;
  onAdd: (serviceIds: string[]) => void;
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return services
      .filter(
        (s) => s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [query, services]);

  const grouped = useMemo(() => groupByCategory(services), [services]);

  function addOne(id: string) {
    onAdd([id]);
    setQuery("");
  }

  function toggle(id: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addChecked() {
    if (checked.size > 0) onAdd([...checked]);
    setChecked(new Set());
    setBrowsing(false);
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <label htmlFor="service-search" className="mb-1.5 block text-sm font-medium text-ink-700">
            {label}
          </label>
          <Input
            id="service-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches[0]) {
                event.preventDefault();
                addOne(matches[0].id);
              }
            }}
            placeholder="Search services..."
            autoComplete="off"
          />
        </div>
        <Button type="button" variant="secondary" onClick={() => setBrowsing(true)}>
          All services
        </Button>
      </div>

      {matches.length > 0 ? (
        <ul className="mt-2 divide-y divide-ink-100 rounded-lg border border-ink-200">
          {matches.map((service) => (
            <li key={service.id}>
              <button
                type="button"
                onClick={() => addOne(service.id)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-ink-700 hover:bg-brand-50 hover:text-brand-700"
              >
                <span className="min-w-0">
                  <span className="truncate font-medium">{service.name}</span>
                  <span className="ml-2 text-xs text-ink-400">{service.category}</span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-ink-500">
                  {formatMoney(service.price, currency)} &middot;{" "}
                  {formatDuration(service.duration_minutes)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {browsing ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="All services"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setBrowsing(false);
          }}
        >
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-ink-200 px-5 py-3">
              <h2 className="text-sm font-semibold text-ink-900">All services</h2>
              <Button type="button" variant="ghost" size="sm" onClick={() => setBrowsing(false)}>
                Close
              </Button>
            </div>

            <div className="flex-1 overflow-auto px-5 py-3">
              {grouped.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-500">
                  No services defined yet.
                </p>
              ) : (
                grouped.map(([category, items]) => (
                  <section key={category} className="mb-4 last:mb-0">
                    <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-500">
                      {category}
                    </h3>
                    <ul className="divide-y divide-ink-100">
                      {items.map((service) => (
                        <li key={service.id}>
                          <label
                            className={cn(
                              "flex cursor-pointer items-center justify-between gap-3 px-1 py-2 text-sm",
                              checked.has(service.id) ? "text-brand-700" : "text-ink-700",
                            )}
                          >
                            <span className="flex min-w-0 items-center gap-2.5">
                              <input
                                type="checkbox"
                                checked={checked.has(service.id)}
                                onChange={() => toggle(service.id)}
                                className="size-4 shrink-0 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                              />
                              <span className="truncate font-medium">{service.name}</span>
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-ink-500">
                              {formatMoney(service.price, currency)} &middot;{" "}
                              {formatDuration(service.duration_minutes)}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-ink-200 bg-ink-50 px-5 py-3">
              <span className="text-sm text-ink-600">
                {checked.size === 0
                  ? "Nothing selected"
                  : `${checked.size} selected`}
              </span>
              <Button type="button" onClick={addChecked} disabled={checked.size === 0}>
                Add selected
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
