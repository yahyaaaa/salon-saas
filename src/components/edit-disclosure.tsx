import type { ReactNode } from "react";

/**
 * A collapsed edit panel. Built on <details> so it works without JavaScript
 * and needs no open/closed state of its own.
 */
export function EditDisclosure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer items-center rounded-lg border border-ink-300 bg-white px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-100 [&::-webkit-details-marker]:hidden">
        {label}
      </summary>
      <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-4">{children}</div>
    </details>
  );
}
