import Link from "next/link";
import type { Metadata } from "next";

import { SignupForm } from "./signup-form";
import { Card } from "@/components/ui";

export const metadata: Metadata = { title: "Create your salon" };

export default function SignupPage() {
  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold tracking-tight text-ink-900">
        Create your salon account
      </h1>
      <p className="mt-1 mb-5 text-sm text-ink-500">
        14 days free, then $20/month. One account per location.
      </p>

      <SignupForm />

      <p className="mt-5 text-sm text-ink-500">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand-700 hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
