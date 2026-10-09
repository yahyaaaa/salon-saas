import Link from "next/link";
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Link href="/" className="mb-8 flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
          S
        </span>
        <span className="text-base font-semibold tracking-tight text-ink-900">
          Salon Suite
        </span>
      </Link>

      <main className="w-full max-w-md">{children}</main>

      <p className="mt-8 text-xs text-ink-400">
        Every salon&rsquo;s data is isolated at the database level.
      </p>
    </div>
  );
}
