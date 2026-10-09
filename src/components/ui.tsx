import type { ComponentProps, ReactNode } from "react";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-xl border border-ink-200 bg-white shadow-xs",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-ink-500">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{title}</h1>
        {description ? <p className="mt-1 text-sm text-ink-500">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Form controls                                                               */
/* -------------------------------------------------------------------------- */

const controlClasses =
  "block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 " +
  "placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25 " +
  "focus:outline-none disabled:cursor-not-allowed disabled:bg-ink-100";

/**
 * A labelled control.
 *
 * SIZE THIS, NOT THE CONTROL INSIDE IT. `Input` and `Select` carry `w-full`
 * from `controlClasses`, and `cn()` is a plain join -- it cannot resolve
 * Tailwind conflicts, so a `w-56` passed to the control competes with `w-full`
 * and which one wins is decided by CSS source order rather than by the call
 * site. The result is a control at some width nobody asked for, which is what
 * made the roster form's two fields fail to share a row.
 *
 * Putting the width here instead is unambiguous: the wrapper is sized, and the
 * control fills it.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-ink-700">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
      {error ? (
        <p className="mt-1 text-xs font-medium text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(controlClasses, className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(controlClasses, className)} {...props} />;
}

export function Button({
  className,
  variant = "primary",
  size = "md",
  ...props
}: ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
}) {
  const variants = {
    primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300",
    secondary:
      "border border-ink-300 bg-white text-ink-700 hover:bg-ink-100 disabled:text-ink-400",
    ghost: "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
    danger: "border border-red-200 bg-white text-red-700 hover:bg-red-50",
  } as const;

  const sizes = {
    sm: "px-2.5 py-1.5 text-xs",
    md: "px-4 py-2 text-sm",
  } as const;

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors",
        "disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

export function Alert({
  tone = "error",
  children,
}: {
  tone?: "error" | "success" | "info" | "warning";
  children: ReactNode;
}) {
  const tones = {
    error: "border-red-200 bg-red-50 text-red-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    info: "border-sky-200 bg-sky-50 text-sky-800",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
  } as const;

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("rounded-lg border px-3.5 py-2.5 text-sm", tones[tone])}
    >
      {children}
    </div>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "brand" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  const tones = {
    neutral: "bg-ink-100 text-ink-600 ring-ink-200",
    brand: "bg-brand-50 text-brand-700 ring-brand-100",
    success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    warning: "bg-amber-50 text-amber-800 ring-amber-200",
    danger: "bg-red-50 text-red-700 ring-red-200",
  } as const;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-5 py-8 text-center text-sm text-ink-500">{children}</p>;
}
