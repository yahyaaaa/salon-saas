/**
 * End-to-end test of the signup and invite flows.
 *
 * Where test-rls.mjs proves that tenants cannot see each other, this one proves
 * that a tenant gets built correctly in the first place -- through the public
 * `auth.signUp` call the signup form actually makes, not the admin API.
 *
 *   npm run test:signup
 *
 * Requires "Confirm email" to be OFF in Authentication -> Sign In / Providers,
 * otherwise every signup tries to send mail and hits the built-in SMTP rate
 * limit. The script says so rather than failing obscurely.
 *
 * It cleans up after itself. Point it at a development project.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !PUBLISHABLE_KEY || !SECRET_KEY) {
  console.error("Missing Supabase environment variables. See .env.example.");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonClient = () =>
  createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/**
 * Supabase Auth rejects `example.com` and dotless/reserved TLDs such as
 * `.local` on the public signup path, so throwaway addresses need a
 * real-looking domain. Nothing is ever delivered to it.
 */
const DOMAIN = "salon-e2e.dev";
const PASSWORD = `Test-${randomUUID().slice(0, 12)}!`;

const createdUserIds = [];
const createdSalonIds = [];

let passed = 0;
let failed = 0;

/*
 * NOTE THE ARGUMENT ORDER: (ok, name).
 *
 * This was declared as (name, ok) while every one of its call sites passed
 * (condition, "description"). The description is a non-empty string and so
 * always truthy, which meant every check in this file reported PASS
 * unconditionally -- printing "PASS true" as its label -- and had never once
 * tested anything. The signature now matches the calls.
 */
function check(ok, name, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  \u001b[32mPASS\u001b[0m  ${name}`);
  } else {
    failed += 1;
    console.log(`  \u001b[31mFAIL\u001b[0m  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function cleanup() {
  for (const id of createdUserIds) {
    try {
      await admin.auth.admin.deleteUser(id);
    } catch {
      /* best effort */
    }
  }
  for (const id of createdSalonIds) {
    try {
      await admin.from("salons").delete().eq("id", id);
    } catch {
      /* best effort */
    }
  }
}

async function main() {
  const email = `owner-${randomUUID().slice(0, 8)}@${DOMAIN}`;

  console.log("\nOwner signup, through the same call the signup form makes\n");

  const { data: signUp, error: signUpError } = await anonClient().auth.signUp({
    email,
    password: PASSWORD,
    options: {
      data: {
        full_name: "Ada Owner",
        salon_name: "E2E Hair Studio",
        business_type: "aesthetic_clinic",
        country: "Pakistan",
        timezone: "Asia/Karachi",
        currency: "PKR",
      },
    },
  });

  if (signUpError?.message?.includes("rate limit")) {
    // Thrown rather than exited so cleanup still runs and open sockets close.
    throw new Error(
      "Supabase hit its email rate limit, which means 'Confirm email' is still ON.\n" +
        "Turn it off under Authentication -> Sign In / Providers -> Email, then re-run.",
    );
  }

  check(!signUpError, "signUp succeeded", signUpError?.message);
  if (signUpError) return;

  createdUserIds.push(signUp.user.id);
  check(Boolean(signUp.session), "signup returns a session (email confirmation is off)");

  // The trigger runs in the same transaction as the auth user, so by the time
  // signUp resolves the whole tenant already exists.
  const { data: profile } = await admin
    .from("profiles")
    .select("*")
    .eq("id", signUp.user.id)
    .maybeSingle();

  check(Boolean(profile), "profile created by the signup trigger");
  if (!profile) return;
  createdSalonIds.push(profile.salon_id);

  check(profile.role === "owner", "role is owner", profile.role);
  check(profile.full_name === "Ada Owner", "full_name carried from metadata", profile.full_name);

  const { data: salon } = await admin
    .from("salons")
    .select("*")
    .eq("id", profile.salon_id)
    .maybeSingle();

  check(salon?.name === "E2E Hair Studio", "salon created with the submitted name", salon?.name);
  check(salon?.business_type === "aesthetic_clinic", "business_type honoured", salon?.business_type);
  check(salon?.timezone === "Asia/Karachi", "timezone honoured", salon?.timezone);
  check(salon?.currency === "PKR", "currency honoured", salon?.currency);
  check(salon?.subscription_status === "trialing", "starts on trial", salon?.subscription_status);

  const trialDays = Math.round((new Date(salon.trial_ends_at) - Date.now()) / 86_400_000);
  check(trialDays === 14, "trial runs 14 days", `${trialDays} days`);

  const { data: settings } = await admin
    .from("salon_settings")
    .select("*")
    .eq("salon_id", profile.salon_id)
    .maybeSingle();

  check(Boolean(settings), "salon_settings row auto-created");
  check(
    Number(settings?.loyalty_earn_rate) === 0.05,
    "loyalty earn rate defaults to 5%",
    String(settings?.loyalty_earn_rate),
  );
  check(
    Object.keys(settings?.business_hours ?? {}).length === 7,
    "business hours seeded for all 7 days",
  );

  const { data: audit } = await admin
    .from("audit_logs")
    .select("*")
    .eq("salon_id", profile.salon_id);

  check(
    audit?.length === 1 && audit[0].action === "salon.created",
    "salon.created audit entry written",
    audit?.[0]?.action,
  );

  /* ---------------------------------------------------------------- */
  console.log("\nSigning in and reading through RLS\n");

  const signedIn = anonClient();
  const { error: signInError } = await signedIn.auth.signInWithPassword({ email, password: PASSWORD });
  check(!signInError, "sign in with password", signInError?.message);

  if (!signInError) {
    const { data: mySalon } = await signedIn.from("salons").select("name");
    check(mySalon?.length === 1 && mySalon[0].name === "E2E Hair Studio", "owner reads own salon");

    const { data: myAudit } = await signedIn.from("audit_logs").select("action");
    check(myAudit?.length === 1, "owner reads own audit log");

    const { error: rateError } = await signedIn
      .from("salon_settings")
      .update({ loyalty_earn_rate: 0.075 })
      .eq("salon_id", profile.salon_id);
    check(!rateError, "owner can change the loyalty rate", rateError?.message);
  }

  /* ---------------------------------------------------------------- */
  console.log("\nSignup with no salon context is refused\n");

  const { error: orphanError } = await anonClient().auth.signUp({
    email: `orphan-${randomUUID().slice(0, 8)}@${DOMAIN}`,
    password: PASSWORD,
    options: { data: { full_name: "No Salon" } },
  });
  // GoTrue masks the trigger's message as a generic database error; what
  // matters is that no auth user without a tenant is ever created.
  check(Boolean(orphanError), "rejected", orphanError?.message);

  /* ---------------------------------------------------------------- */
  console.log("\nInvite flow\n");

  const inviteEmail = `staff-${randomUUID().slice(0, 8)}@${DOMAIN}`;

  const { data: invitation, error: invitationError } = await admin
    .from("invitations")
    .insert({
      salon_id: profile.salon_id,
      email: inviteEmail,
      role: "receptionist",
      full_name: "Rey Desk",
      invited_by: signUp.user.id,
    })
    .select("id")
    .single();

  check(!invitationError, "invitation row created", invitationError?.message);

  const { data: invited, error: sendError } = await admin.auth.admin.inviteUserByEmail(
    inviteEmail,
    { redirectTo: "http://localhost:3000/auth/confirm?next=/accept-invite" },
  );

  if (sendError) {
    console.log(`  \u001b[33mSKIP\u001b[0m  invite email could not be sent: ${sendError.message}`);
    console.log(
      "        Supabase's built-in SMTP is rate limited and only delivers to\n" +
        "        project members. Configure custom SMTP to use invites for real.",
    );
  } else {
    createdUserIds.push(invited.user.id);

    const { data: staffProfile } = await admin
      .from("profiles")
      .select("*")
      .eq("id", invited.user.id)
      .maybeSingle();

    check(staffProfile?.salon_id === profile.salon_id, "invited user joined the inviting salon");
    check(staffProfile?.role === "receptionist", "invited user got the invited role", staffProfile?.role);

    const { data: invRow } = await admin
      .from("invitations")
      .select("status")
      .eq("id", invitation.id)
      .single();
    check(invRow?.status === "accepted", "invitation marked accepted", invRow?.status);
  }

  /* ---------------------------------------------------------------- */
  console.log("\nThe invitation link actually signs someone in\n");

  /*
   * The flow above stops at "the email was sent", because Supabase's built-in
   * SMTP only delivers to project members -- so the half that matters, what
   * happens when the invited person CLICKS the link, had no coverage at all.
   * That is how a broken invite link reached a real user.
   *
   * `generateLink` produces exactly the link the email carries without sending
   * anything, so the whole hop can be followed here.
   */
  const linkOwnerEmail = `link-owner-${randomUUID().slice(0, 8)}@salon-e2e.dev`;
  const { data: linkOwner, error: linkOwnerError } = await admin.auth.admin.createUser({
    email: linkOwnerEmail,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: {
      full_name: "Link Owner",
      salon_name: "Link Flow Salon",
      business_type: "salon",
      country: "US",
      timezone: "UTC",
      currency: "USD",
    },
  });
  check(!linkOwnerError, "a salon exists to invite into", linkOwnerError?.message);
  createdUserIds.push(linkOwner.user.id);

  const { data: linkProfile } = await admin
    .from("profiles")
    .select("salon_id")
    .eq("id", linkOwner.user.id)
    .single();
  createdSalonIds.push(linkProfile.salon_id);

  const { data: linkRole } = await admin
    .from("roles")
    .select("id, name")
    .eq("salon_id", linkProfile.salon_id)
    .eq("name", "Receptionist")
    .single();

  const linkInviteeEmail = `link-invitee-${randomUUID().slice(0, 8)}@salon-e2e.dev`;
  await admin.from("invitations").insert({
    salon_id: linkProfile.salon_id,
    email: linkInviteeEmail,
    role: "receptionist",
    role_id: linkRole.id,
    full_name: "Link Invitee",
    invited_by: linkOwner.user.id,
  });

  /*
   * Everything below proves the callback URL WORKS. It cannot prove the app
   * points at it -- the redirect target is chosen inside a Server Action and
   * never appears in any response -- so that is asserted against the source,
   * crudely but honestly. Without it, someone could point invitations back at
   * /auth/confirm and every check here would still pass.
   */
  const inviteSource = await readFile(
    "src/app/(dashboard)/dashboard/team/actions.ts",
    "utf8",
  );
  const redirectLine =
    inviteSource.split(/\r?\n/).find((l) => l.includes("redirectTo:")) ?? "";
  check(
    redirectLine.includes("/auth/callback"),
    "the invite action sends people to the callback page",
    redirectLine.trim().slice(0, 90),
  );
  check(
    !redirectLine.includes("/auth/confirm"),
    "and not to the route that cannot read a fragment",
  );

  const callbackUrl = "http://localhost:3000/auth/callback?next=%2Faccept-invite";
  const { data: generated, error: generateError } = await admin.auth.admin.generateLink({
    type: "invite",
    email: linkInviteeEmail,
    options: { redirectTo: callbackUrl },
  });
  check(!generateError, "an invitation link is generated", generateError?.message);

  const actionLink = generated?.properties?.action_link ?? "";
  check(Boolean(actionLink), "the email carries a link");

  // Follow it exactly as the browser would, without following the redirect.
  const verified = await fetch(actionLink, { redirect: "manual" });
  const landing = verified.headers.get("location") ?? "";

  check(
    landing.includes("/auth/callback"),
    "it lands on the callback page",
    landing.slice(0, 90),
  );
  check(
    !landing.includes("/auth/confirm"),
    "and not on the route that cannot read a fragment",
  );

  const fragment = new URLSearchParams(
    landing.includes("#") ? landing.slice(landing.indexOf("#") + 1) : "",
  );

  /*
   * The crux of the bug: the session comes back in the FRAGMENT, which is
   * never sent to a server. A route handler looking for `token_hash` in the
   * query string sees an empty query and refuses a perfectly good link.
   */
  check(
    Boolean(fragment.get("access_token") && fragment.get("refresh_token")),
    "the session arrives in the fragment, not the query string",
    landing.includes("#") ? "keys: " + [...fragment.keys()].join(", ") : "no fragment",
  );
  check(fragment.get("type") === "invite", "and is marked as an invitation");
  check(
    !new URL(landing.split("#")[0]).searchParams.has("token_hash"),
    "with no token_hash in the query, which is what the old route required",
  );

  // What the callback page does in the browser.
  const invitedClient = anonClient();
  const { data: invitedSession, error: invitedError } = await invitedClient.auth.setSession({
    access_token: fragment.get("access_token"),
    refresh_token: fragment.get("refresh_token"),
  });
  check(!invitedError, "those tokens establish a session", invitedError?.message);
  check(
    invitedSession?.user?.email === linkInviteeEmail,
    "belonging to the invited person",
  );
  if (invitedSession?.user) createdUserIds.push(invitedSession.user.id);

  // And that session can read what /accept-invite renders from.
  const { data: invitedProfile } = await invitedClient
    .from("profiles")
    .select("salon_id, role_id")
    .eq("id", invitedSession.user.id)
    .maybeSingle();
  check(Boolean(invitedProfile), "their profile is readable through RLS");
  check(
    invitedProfile?.salon_id === linkProfile.salon_id,
    "in the salon that invited them",
  );
  check(
    invitedProfile?.role_id === linkRole.id,
    "holding the role the invitation named",
  );

  const { data: invitedSalon } = await invitedClient
    .from("salons")
    .select("name")
    .eq("id", linkProfile.salon_id)
    .maybeSingle();
  check(
    invitedSalon?.name === "Link Flow Salon",
    "so the page can greet them with the salon name",
    invitedSalon?.name,
  );

}



main()
  .then(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exitCode = failed === 0 ? 0 : 1;
  })
  .catch(async (error) => {
    await cleanup();
    console.error("\nTest run aborted:", error.message, "\n");
    process.exitCode = 1;
  });
