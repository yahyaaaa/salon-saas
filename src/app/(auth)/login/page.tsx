import Link from "next/link";
import type { Metadata } from "next";

import { LoginForm } from "./login-form";
import { Alert, Card } from "@/components/ui";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;
  const confirmed = params.confirmed === "1";
  const error = typeof params.error === "string" ? params.error : undefined;

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold tracking-tight text-ink-900">Sign in</h1>
      <p className="mt-1 mb-5 text-sm text-ink-500">
        Welcome back. Sign in to your salon dashboard.
      </p>

      {confirmed ? (
        <div className="mb-4">
          <Alert tone="success">Email confirmed. You can sign in now.</Alert>
        </div>
      ) : null}

      {error ? (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      <LoginForm next={next} />

      <p className="mt-5 text-sm text-ink-500">
        New here?{" "}
        <Link href="/signup" className="font-medium text-brand-700 hover:underline">
          Create a salon account
        </Link>
      </p>
    </Card>
  );
}
