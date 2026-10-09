import type { Metadata } from "next";

import { AccountForm } from "./account-form";
import { requireSession, ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/auth/session";
import { Card, CardHeader, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "My account" };

export default async function AccountPage() {
  const session = await requireSession();

  return (
    <>
      <PageHeader title="My account" description="Your details at this salon." />

      <Card>
        <CardHeader title="Profile" />
        <div className="px-5 py-4">
          <AccountForm
            email={session.email}
            fullName={session.profile.full_name}
            phone={session.profile.phone ?? ""}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Role" description={ROLE_DESCRIPTIONS[session.profile.role]} />
        <div className="px-5 py-4 text-sm text-ink-600">
          <p>
            You are <strong>{ROLE_LABELS[session.profile.role]}</strong> at{" "}
            <strong>{session.salon.name}</strong>. Only an owner can change a role, and
            nobody can change their own &mdash; the database rejects it.
          </p>
        </div>
      </Card>
    </>
  );
}
