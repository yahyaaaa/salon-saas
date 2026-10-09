import Link from "next/link";
import type { Metadata } from "next";

import { AcceptInviteForm } from "./accept-invite-form";
import { getSessionContext, ROLE_LABELS } from "@/lib/auth/session";
import { Alert, Card } from "@/components/ui";

export const metadata: Metadata = { title: "Accept your invitation" };

export default async function AcceptInvitePage() {
  // The invite link verifies an OTP before landing here, so an accepted
  // invitation already has a session, a profile, a salon and a role.
  const session = await getSessionContext();

  if (!session) {
    return (
      <Card className="p-6">
        <Alert tone="error">
          <p className="font-medium">This invitation link is no longer valid</p>
          <p className="mt-1">
            Invitation links expire after 7 days. Ask your salon owner to send a new one.
          </p>
        </Alert>
        <p className="mt-5 text-sm text-ink-500">
          Already set up?{" "}
          <Link href="/login" className="font-medium text-brand-700 hover:underline">
            Sign in
          </Link>
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold tracking-tight text-ink-900">
        Join {session.salon.name}
      </h1>
      <p className="mt-1 mb-5 text-sm text-ink-500">
        You have been added as <strong>{ROLE_LABELS[session.profile.role]}</strong>. Choose a
        password to finish setting up your account.
      </p>

      <AcceptInviteForm defaultName={session.profile.full_name} />
    </Card>
  );
}
