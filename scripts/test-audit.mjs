/**
 * Audit log verification (Phase 7).
 *
 * The brief requires a fixed list of sensitive actions to be logged, an
 * owner-only view of the log with date/actor/action filters, and a log that is
 * "read-only, never editable or deletable".
 *
 * Every action below is triggered through the RUNNING APPLICATION -- real
 * login, real Server Actions, real session cookies -- rather than by writing
 * the audit row the test expects to find. Most audit entries come from
 * `logAudit()` inside a Server Action, so a test that spoke to Postgres
 * directly would be checking its own arithmetic.
 *
 *   npm run build && npm run start     # in one terminal
 *   npm run test:audit                 # in another
 *
 * Creates and deletes its own salon. Point it at a development project.
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

import { act, assertFreshBuild, callAction, createSession, get, signIn } from "./lib/app-driver.mjs";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error("Missing Supabase environment variables. See .env.example.");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = `Audit-${randomUUID().slice(0, 12)}!`;
const createdUserIds = [];
const createdSalonIds = [];

let passed = 0;
let failed = 0;
const missing = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [32mPASS[0m  ${name}`);
  } else {
    failed += 1;
    console.log(`  [31mFAIL[0m  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
  return ok;
}

function skip(name, reason) {
  console.log(`  [33mSKIP[0m  ${name} -- ${reason}`);
}

let SALON_ID = null;

/** Every audit row for this salon, newest first. */
async function auditRows(action) {
  let query = admin
    .from("audit_logs")
    .select("*")
    .eq("salon_id", SALON_ID)
    .order("created_at", { ascending: false });
  if (action) query = query.eq("action", action);
  const { data } = await query;
  return data ?? [];
}

/**
 * Run `fn`, then assert exactly the expected audit action appeared.
 *
 * `verify` receives the new entry, so each case can also check that the
 * metadata is the right shape -- an entry that fires but records nothing
 * useful is not much of an audit trail.
 */
async function expectAudit(label, action, fn, verify) {
  const before = (await auditRows(action)).length;

  let ranCleanly = true;
  let failure = "";
  try {
    await fn();
  } catch (error) {
    ranCleanly = false;
    failure = error.message;
  }

  const after = await auditRows(action);
  const appeared = after.length > before;

  if (!appeared) {
    missing.push(action);
    check(
      `${label} -> ${action}`,
      false,
      ranCleanly ? "no audit entry was written" : `action failed: ${failure}`,
    );
    return null;
  }

  const entry = after[0];
  const problems = [];
  if (entry.salon_id !== SALON_ID) problems.push("wrong salon_id");
  if (!entry.created_at) problems.push("no timestamp");
  if (!entry.actor_id && action !== "salon.created") problems.push("no actor");
  if (!entry.actor_role) problems.push("no actor role");
  if (verify) {
    const extra = verify(entry);
    if (typeof extra === "string") problems.push(extra);
  }

  check(`${label} -> ${action}`, problems.length === 0, problems.join(", "));
  return entry;
}

async function cleanup() {
  for (const id of createdSalonIds) {
    for (const table of ["consent_forms", "appointments"]) {
      try {
        await admin.from(table).delete().eq("salon_id", id);
      } catch {
        /* best effort */
      }
    }
    try {
      await admin.from("salons").delete().eq("id", id);
    } catch {
      /* best effort */
    }
  }
  for (const id of createdUserIds) {
    try {
      await admin.auth.admin.deleteUser(id);
    } catch {
      /* best effort */
    }
  }
}

/** A 1x1 PNG, standing in for what the signature pad would produce. */
const SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function main() {
  const reachable = await fetch(`${BASE}/login`).then(
    (r) => r.ok,
    () => false,
  );
  if (!reachable) {
    throw new Error(
      `The app is not responding at ${BASE}. Run "npm run build && npm run start" first.`,
    );
  }

  await assertFreshBuild();

  console.log("\nSetting up: owner signs up through the real signup form\n");

  const ownerEmail = `owner-${randomUUID().slice(0, 8)}@rls-test.local`;
  const salonName = `Audit Salon ${randomUUID().slice(0, 4)}`;
  const owner = createSession();

  await act(owner, "/signup", 'name="salonName"', {
    salonName,
    businessType: "salon",
    fullName: "Ada Owner",
    email: ownerEmail,
    password: PASSWORD,
    country: "United States",
    currency: "USD",
    timezone: "UTC",
  });

  const { data: ownerUser } = await admin.auth.admin.listUsers();
  const ownerRecord = ownerUser.users.find((u) => u.email === ownerEmail);
  if (!ownerRecord) throw new Error("Signup through the app did not create a user");
  createdUserIds.push(ownerRecord.id);

  const { data: ownerProfile } = await admin
    .from("profiles")
    .select("salon_id")
    .eq("id", ownerRecord.id)
    .single();
  SALON_ID = ownerProfile.salon_id;
  createdSalonIds.push(SALON_ID);

  const dashboard = await get(owner, "/dashboard");
  check("the owner is signed in after signing up", dashboard.body.includes(salonName));

  /* ================================================================ */
  console.log("\n1-2. Salon and settings\n");

  // salon.created is written by the signup trigger, inside the same
  // transaction as the auth user.
  const created = await auditRows("salon.created");
  check(
    "signing up -> salon.created",
    created.length === 1 && created[0].salon_id === SALON_ID,
    `found ${created.length}`,
  );

  await expectAudit(
    "changing the loyalty rate and business details",
    "salon.settings_changed",
    async () => {
      await act(owner, "/dashboard/settings", 'name="salonName"', {
        salonName,
        businessType: "salon",
        country: "United States",
        timezone: "UTC",
        currency: "USD",
        loyaltyEarnRatePercent: "7.5",
        "hours.mon.open": "09:00",
        "hours.mon.close": "18:00",
        "hours.tue.open": "09:00",
        "hours.tue.close": "18:00",
        "hours.wed.open": "09:00",
        "hours.wed.close": "18:00",
        "hours.thu.open": "09:00",
        "hours.thu.close": "18:00",
        "hours.fri.open": "09:00",
        "hours.fri.close": "18:00",
        "hours.sat.open": "10:00",
        "hours.sat.close": "16:00",
        "hours.sun.open": "10:00",
        "hours.sun.close": "16:00",
      });
    },
    (entry) =>
      Number(entry.metadata?.loyalty_earn_rate_to) === 0.075
        ? null
        : `loyalty rate not recorded (got ${entry.metadata?.loyalty_earn_rate_to})`,
  );

  /* ================================================================ */
  console.log("\n3-6. Staff accounts\n");

  // The invite endpoint validates the domain's MX records -- stricter than
  // public signup, which only rejects `.local` and `example.com`. It wants a
  // domain that genuinely accepts mail; nothing here is ever read.
  const staffEmail = `therapist-${randomUUID().slice(0, 8)}@mailinator.com`;

  /*
   * Roles are rows a salon defines, so a test that invites someone has to name
   * one. The owner role is deliberately not among them -- the database refuses
   * to assign it -- so these use the built-ins the salon is seeded with.
   */
  const { data: salonRoles } = await admin
    .from("roles")
    .select("id, name, is_owner")
    .eq("salon_id", SALON_ID);

  const roleNamed = (name) => (salonRoles ?? []).find((r) => r.name === name)?.id ?? null;
  const staffRoleId = roleNamed("Staff / Therapist");
  const receptionRoleId = roleNamed("Receptionist");
  check("the salon has its built-in roles", Boolean(staffRoleId && receptionRoleId));

  const inviteEntry = await expectAudit(
    "inviting a team member",
    "staff.invited",
    async () => {
      await act(owner, "/dashboard/team", 'name="teamMemberId"', {
        email: staffEmail,
        fullName: "Tess Therapist",
        roleId: staffRoleId,
        teamMemberId: "",
      });
    },
    (entry) =>
      entry.metadata?.email === staffEmail ? null : "invited email not recorded",
  );

  // If the invite could not be sent, the action rolls the invitation back and
  // there is nothing to accept. Fall back to creating the member directly so
  // the remaining staff cases still run, and report why rather than swallow it.
  let staffId = null;
  if (inviteEntry) {
    const { data: invited } = await admin.auth.admin.listUsers();
    staffId = invited.users.find((u) => u.email === staffEmail)?.id ?? null;
  }

  if (staffId) {
    createdUserIds.push(staffId);
    const accepted = await auditRows("staff.invite_accepted");
    check(
      "the invited user joining -> staff.invite_accepted",
      accepted.length === 1,
      `found ${accepted.length}`,
    );
  } else {
    skip(
      "the invited user joining -> staff.invite_accepted",
      "the invitation was not sent, so there was nothing to accept",
    );
    const fallbackEmail = `therapist-${randomUUID().slice(0, 8)}@mailinator.com`;
    await admin
      .from("invitations")
      .insert({ salon_id: SALON_ID, email: fallbackEmail, role: "staff" });
    const { data: made } = await admin.auth.admin.createUser({
      email: fallbackEmail,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Tess Therapist" },
    });
    staffId = made.user.id;
    createdUserIds.push(staffId);

    const accepted = await auditRows("staff.invite_accepted");
    check(
      "a user joining via an invitation -> staff.invite_accepted",
      accepted.length >= 1,
      `found ${accepted.length}`,
    );
  }

  /*
   * Bookings name a ROSTER entry, not a login. Everything below books and
   * completes appointments, so it needs the team member the invitation
   * created alongside the account.
   */
  const { data: staffRoster } = await admin
    .from("profiles")
    .select("team_member_id")
    .eq("id", staffId)
    .maybeSingle();
  const staffMemberId = staffRoster?.team_member_id ?? null;
  check("the invited account is on the roster", Boolean(staffMemberId));

  await expectAudit(
    "changing a role",
    "staff.role_changed",
    async () => {
      await act(owner, "/dashboard/team", [`value="${staffId}"`, 'name="roleId"'], {
        profileId: staffId,
        roleId: receptionRoleId,
      });
    },
    (entry) =>
      entry.metadata?.to === "Receptionist"
        ? null
        : `role change not recorded (${JSON.stringify(entry.metadata)})`,
  );

  // Put them back, so they can perform treatments later on.
  await act(owner, "/dashboard/team", [`value="${staffId}"`, 'name="roleId"'], {
    profileId: staffId,
    roleId: staffRoleId,
  });

  await expectAudit("removing access", "staff.deactivated", async () => {
    // The Team page has three forms carrying one or other of these fields:
    // linking a login (profileId), taking someone off the roster (isActive),
    // and this one. Only this form has BOTH.
    await act(owner, "/dashboard/team", ['name="profileId"', 'name="isActive"'], {
      profileId: staffId,
      isActive: "false",
    });
  });

  await expectAudit("restoring access", "staff.reactivated", async () => {
    // The Team page has three forms carrying one or other of these fields:
    // linking a login (profileId), taking someone off the roster (isActive),
    // and this one. Only this form has BOTH.
    await act(owner, "/dashboard/team", ['name="profileId"', 'name="isActive"'], {
      profileId: staffId,
      isActive: "true",
    });
  });

  await expectAudit("revoking an invitation", "staff.invite_revoked", async () => {
    const pendingEmail = `pending-${randomUUID().slice(0, 8)}@rls-test.local`;
    const { data: invitation } = await admin
      .from("invitations")
      .insert({ salon_id: SALON_ID, email: pendingEmail, role: "receptionist" })
      .select("id")
      .single();
    await act(owner, "/dashboard/team", `value="${invitation.id}"`, {
      invitationId: invitation.id,
    });
  });

  /* ================================================================ */
  console.log("\n7-9. Services, prices and deals\n");

  await expectAudit(
    "adding a service",
    "service.created",
    async () => {
      await act(owner, "/dashboard/services", 'name="durationMinutes"', {
        name: "Signature Facial",
        category: "Face",
        description: "",
        price: "100",
        durationMinutes: "60",
        consentTemplateId: "",
      });
    },
    (entry) => (entry.metadata?.name === "Signature Facial" ? null : "service name not recorded"),
  );

  const { data: service } = await admin
    .from("services")
    .select("id")
    .eq("salon_id", SALON_ID)
    .eq("name", "Signature Facial")
    .single();

  await expectAudit(
    "changing a price",
    "service.updated",
    async () => {
      await act(owner, "/dashboard/services", `value="${service.id}"`, {
        serviceId: service.id,
        name: "Signature Facial",
        category: "Face",
        description: "",
        price: "125",
        durationMinutes: "60",
        consentTemplateId: "",
      });
    },
    (entry) => (Number(entry.metadata?.price) === 125 ? null : "new price not recorded"),
  );

  await expectAudit("archiving a service", "service.archived", async () => {
    await act(owner, "/dashboard/services", `name="isActive"`, {
      serviceId: service.id,
      isActive: "false",
    });
  });

  await expectAudit("restoring a service", "service.restored", async () => {
    await act(owner, "/dashboard/services", `name="isActive"`, {
      serviceId: service.id,
      isActive: "true",
    });
  });

  await expectAudit("creating a deal", "deal.created", async () => {
    await act(owner, "/dashboard/services", 'name="dealType"', {
      name: "Launch offer",
      dealType: "percentage",
      value: "10",
      startsOn: "2026-01-01",
      endsOn: "2099-12-31",
      serviceIds: [service.id],
    });
  });

  const { data: deal } = await admin
    .from("deals")
    .select("id")
    .eq("salon_id", SALON_ID)
    .eq("name", "Launch offer")
    .single();

  await expectAudit("editing a deal", "deal.updated", async () => {
    await act(owner, "/dashboard/services", [`value="${deal.id}"`, 'name="dealType"'], {
      dealId: deal.id,
      name: "Launch offer",
      dealType: "percentage",
      value: "15",
      startsOn: "2026-01-01",
      endsOn: "2099-12-31",
      serviceIds: [service.id],
    });
  });

  await expectAudit("archiving a deal", "deal.archived", async () => {
    await act(owner, "/dashboard/services", [`value="${deal.id}"`, ">Archive<"], { dealId: deal.id });
  });

  /* ================================================================ */
  console.log("\n10-12. Consent templates\n");

  await expectAudit("creating a consent template", "consent_template.created", async () => {
    await act(owner, "/dashboard/services", 'name="requiresMedicalHistory"', {
      name: "Facial consent",
      items: "I consent to the treatment as explained\nI have disclosed my allergies",
      description: "",
      requiresMedicalHistory: "on",
    });
  });

  const { data: template } = await admin
    .from("consent_templates")
    .select("id")
    .eq("salon_id", SALON_ID)
    .eq("name", "Facial consent")
    .single();

  await expectAudit("editing a consent template", "consent_template.updated", async () => {
    await act(owner, "/dashboard/services", [`value="${template.id}"`, 'name="items"'], {
      templateId: template.id,
      name: "Facial consent",
      items: "I consent to the treatment as explained",
      description: "Updated wording",
      requiresMedicalHistory: "on",
    });
  });

  await expectAudit("archiving a consent template", "consent_template.archived", async () => {
    await act(owner, "/dashboard/services", [`value="${template.id}"`, ">Archive<"], { templateId: template.id });
  });

  /* ================================================================ */
  console.log("\n13-14. Customers\n");

  const phone = `+1555${String(Date.now()).slice(-7)}`;

  await expectAudit(
    "creating a customer",
    "customer.created",
    async () => {
      await act(owner, "/dashboard/customers", 'name="dateOfBirth"', {
        fullName: "Pat Customer",
        phone,
        email: "",
        dateOfBirth: "",
        notes: "",
      });
    },
    (entry) => {
      if (entry.metadata?.name !== "Pat Customer") return "customer name not recorded";
      // Sensitive detail must not be copied into the log.
      if ("notes" in (entry.metadata ?? {})) return "notes leaked into the audit metadata";
      return null;
    },
  );

  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("salon_id", SALON_ID)
    .eq("full_name", "Pat Customer")
    .single();

  await expectAudit("editing a customer", "customer.updated", async () => {
    await act(owner, `/dashboard/customers/${customer.id}`, `value="${customer.id}"`, {
      customerId: customer.id,
      fullName: "Pat Customer",
      phone,
      email: "pat@rls-test.local",
      dateOfBirth: "",
      notes: "Prefers mornings",
    });
  });

  /* ================================================================ */
  console.log("\n15. Consent forms\n");

  await expectAudit(
    "collecting a consent form",
    "consent_form.created",
    async () => {
      await act(owner, `/dashboard/customers/${customer.id}`, 'name="signature"', {
        customerId: customer.id,
        templateId: "",
        serviceId: "",
        appointmentId: "",
        medicalHistory: "No known conditions",
        allergies: "Penicillin",
        responses: "[]",
        signature: SIGNATURE,
      });
    },
    (entry) => {
      const meta = entry.metadata ?? {};
      if (meta.customer_id !== customer.id) return "customer not recorded";
      // The whole point of the restriction: medical detail stays out of the log.
      const blob = JSON.stringify(meta).toLowerCase();
      if (blob.includes("penicillin") || blob.includes("no known conditions")) {
        return "MEDICAL DETAIL LEAKED INTO THE AUDIT LOG";
      }
      return null;
    },
  );

  // Viewing a signature is a Server Action called from a client component, not
  // submitted by a form, so it is invoked directly. Reading a medical record is
  // worth recording, which is why it is audited at all.
  await expectAudit(
    "viewing a consent signature",
    "consent_form.viewed",
    async () => {
      const { data: forms } = await admin
        .from("consent_forms")
        .select("id, signature_path, signed_at")
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false });
      const form = (forms ?? []).find((f) => f.signature_path && f.signed_at);
      if (!form) {
        throw new Error(
          `no signed consent form to view (found ${(forms ?? []).length} form(s))`,
        );
      }
      const result = await callAction(
        owner,
        `/dashboard/customers/${customer.id}`,
        "getSignatureUrlAction",
        [form.id],
      );
      if (result.status >= 400) throw new Error(`action returned ${result.status}`);
    },
    (entry) => (entry.metadata?.customer_id === customer.id ? null : "customer not recorded"),
  );

  /* ================================================================ */
  console.log("\n16-20. Appointments\n");

  const today = new Date().toISOString().slice(0, 10);

  await expectAudit("booking an appointment", "appointment.booked", async () => {
    await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
      customerMode: "existing",
      customerId: customer.id,
      staffId: staffMemberId,
      lines: JSON.stringify([{ serviceId: service.id, quantity: 1 }]),
      discount: "0",
      quotedTotal: "",
      date: today,
      time: "09:00",
      notes: "",
    });
  });

  const { data: appointment } = await admin
    .from("appointments")
    .select("id")
    .eq("salon_id", SALON_ID)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  await expectAudit("confirming an appointment", "appointment.confirmed", async () => {
    await act(owner, "/dashboard/calendar", `value="confirmed"`, {
      appointmentId: appointment.id,
      status: "confirmed",
    });
  });

  await expectAudit("moving an appointment", "appointment.rescheduled", async () => {
    await act(owner, "/dashboard/calendar", ['name="appointmentId"', 'name="date"'], {
      appointmentId: appointment.id,
      staffId: staffMemberId,
      date: today,
      time: "11:00",
    });
  });

  await expectAudit("completing an appointment", "appointment.completed", async () => {
    await act(owner, "/dashboard/calendar", `value="completed"`, {
      appointmentId: appointment.id,
      status: "completed",
    });
  });

  // Cancellation and no-show each need their own appointment, since a resolved
  // one cannot change again.
  async function freshAppointment(time) {
    await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
      customerMode: "existing",
      customerId: customer.id,
      staffId: staffMemberId,
      lines: JSON.stringify([{ serviceId: service.id, quantity: 1 }]),
      discount: "0",
      quotedTotal: "",
      date: today,
      time,
      notes: "",
    });
    const { data } = await admin
      .from("appointments")
      .select("id")
      .eq("salon_id", SALON_ID)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    return data.id;
  }

  const toCancel = await freshAppointment("13:00");
  await expectAudit(
    "cancelling an appointment",
    "appointment.cancelled",
    async () => {
      await act(owner, "/dashboard/calendar", `name="reason"`, {
        appointmentId: toCancel,
        status: "cancelled",
        reason: "Customer rang to cancel",
      });
    },
    (entry) =>
      entry.metadata?.reason === "Customer rang to cancel"
        ? null
        : "the cancellation reason was not recorded",
  );

  const toMiss = await freshAppointment("14:00");
  await expectAudit(
    "marking a no-show",
    "appointment.no_show",
    async () => {
      await act(owner, "/dashboard/calendar", `name="reason"`, {
        appointmentId: toMiss,
        status: "no_show",
        reason: "Did not arrive",
      });
    },
    (entry) =>
      entry.metadata?.reason === "Did not arrive" ? null : "the no-show reason was not recorded",
  );

  /* ================================================================ */
  console.log("\n21-23. Receipts and loyalty\n");

  const basket = JSON.stringify([
    { serviceId: service.id, staffId: staffMemberId, quantity: 1 },
  ]);

  await expectAudit(
    "issuing a receipt",
    "receipt.created",
    async () => {
      await act(owner, "/dashboard/pos", 'name="paymentMethod"', {
        customerMode: "existing",
        customerId: customer.id,
        dealId: "",
        paymentMethod: "cash",
        cashAmount: "0",
        cardAmount: "0",
        loyaltyRedeem: "0",
        notes: "",
        lines: basket,
      });
    },
    (entry) =>
      Number(entry.metadata?.total) === 125 ? null : `total not recorded (${entry.metadata?.total})`,
  );

  // That receipt earned 7.5% of 125 = 9.38. Spend some of it on the next one.
  await expectAudit(
    "redeeming loyalty at the till",
    "loyalty.redeemed",
    async () => {
      await act(owner, "/dashboard/pos", 'name="paymentMethod"', {
        customerMode: "existing",
        customerId: customer.id,
        dealId: "",
        paymentMethod: "cash",
        cashAmount: "0",
        cardAmount: "0",
        loyaltyRedeem: "5",
        notes: "",
        lines: basket,
      });
    },
    (entry) => (Number(entry.metadata?.amount) === 5 ? null : "redeemed amount not recorded"),
  );

  const { data: receipt } = await admin
    .from("receipts")
    .select("id")
    .eq("salon_id", SALON_ID)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  await expectAudit(
    "voiding a receipt",
    "receipt.voided",
    async () => {
      await act(owner, `/dashboard/pos/${receipt.id}`, 'name="reason"', {
        receiptId: receipt.id,
        reason: "Charged the wrong customer",
      });
    },
    (entry) =>
      entry.metadata?.reason === "Charged the wrong customer"
        ? null
        : "the void reason was not recorded",
  );

  /* ================================================================ */
  console.log("\n24-26. Payroll\n");

  await expectAudit(
    "setting a commission rate",
    "payroll.commission_rate_changed",
    async () => {
      // Salary and commission are separate fields now, so both travel.
      await act(owner, "/dashboard/payroll", [`value="${staffMemberId}"`, 'name="commissionBasis"'], {
        staffId: staffMemberId,
        salaryAmount: "0",
        commissionBasis: "percentage",
        commissionPercent: "30",
        fixedAmount: "0",
        joiningDate: "",
      });
    },
    (entry) => (entry.metadata?.to ? null : "the new rate was not recorded"),
  );

  await expectAudit("generating payroll", "payroll.generated", async () => {
    await act(owner, "/dashboard/payroll", 'name="startsOn"', {
      startsOn: today,
      endsOn: today,
      notes: "audit test",
    });
  });

  const { data: period } = await admin
    .from("payroll_periods")
    .select("id")
    .eq("salon_id", SALON_ID)
    .limit(1)
    .single();

  await expectAudit("marking payroll paid", "payroll.marked_paid", async () => {
    await act(owner, "/dashboard/payroll", [`value="${period.id}"`, ">Mark paid<"], { periodId: period.id });
  });

  /* ================================================================ */
  console.log("\nEvery action the brief names is covered\n");

  const REQUIRED = [
    ["receipt created", "receipt.created"],
    ["receipt voided / refunded", "receipt.voided"],
    ["appointment cancelled", "appointment.cancelled"],
    ["no-show marked", "appointment.no_show"],
    ["staff account added", "staff.invite_accepted"],
    ["staff account removed", "staff.deactivated"],
    ["staff role changed", "staff.role_changed"],
    ["payroll marked paid", "payroll.marked_paid"],
    ["consent form created", "consent_form.created"],
    ["loyalty redemption applied", "loyalty.redeemed"],
    ["salon settings changed", "salon.settings_changed"],
    ["services changed", "service.created"],
    ["prices changed", "service.updated"],
  ];

  for (const [clause, action] of REQUIRED) {
    const rows = await auditRows(action);
    check(`brief: "${clause}" is logged`, rows.length > 0, `no ${action} entry`);
  }

  /* ================================================================ */
  console.log("\nThe audit view: owner only\n");

  const staffSession = createSession();
  const { data: staffProfile } = await admin
    .from("profiles")
    .select("email")
    .eq("id", staffId)
    .single();

  // An invited user sets their own password through the invite link, so give
  // this one a known password rather than skipping the check.
  // An invited user's email is not confirmed until they follow the link, and an
  // unconfirmed account cannot sign in with a password.
  await admin.auth.admin.updateUserById(staffId, {
    password: PASSWORD,
    email_confirm: true,
  });
  await signIn(staffSession, staffProfile.email, PASSWORD);

  const staffAuditPage = await get(staffSession, "/dashboard/audit");
  check(
    "a therapist is redirected away from the audit log",
    staffAuditPage.status === 307 || staffAuditPage.status === 302,
    `got ${staffAuditPage.status}`,
  );

  // The redirect is a courtesy; the policy is the actual boundary.
  const staffDirect = createClient(
    SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  await staffDirect.auth.signInWithPassword({
    email: staffProfile.email,
    password: PASSWORD,
  });
  const { data: staffRows } = await staffDirect.from("audit_logs").select("id");
  check("and cannot read audit_logs through the API either", (staffRows ?? []).length === 0);

  const ownerPage = await get(owner, "/dashboard/audit");
  check("the owner can open the audit log", ownerPage.status === 200);
  check(
    "and it lists entries",
    ownerPage.body.includes("Receipt issued") || ownerPage.body.includes("Settings changed"),
  );

  /* ================================================================ */
  console.log("\nThe audit view: filters\n");

  // Count rendered rows rather than searching the page for a label: the filter
  // dropdown lists EVERY action name, so a substring search would match
  // regardless of what the filter actually did. Each entry renders one <time>.
  const countRows = (html) => (html.match(/<time/g) ?? []).length;

  const allRows = await auditRows();

  async function expectFilter(label, query, expected) {
    const page = await get(owner, `/dashboard/audit?${query}`);
    const rendered = countRows(page.body);
    check(
      `${label} -> ${expected} ${expected === 1 ? "entry" : "entries"}`,
      page.status === 200 && rendered === expected,
      `rendered ${rendered}`,
    );
  }

  const countWhere = (fn) => allRows.filter(fn).length;

  await expectFilter(
    "filter by action: receipt.voided",
    "action=receipt.voided",
    countWhere((r) => r.action === "receipt.voided"),
  );
  await expectFilter(
    "filter by action: receipt.created",
    "action=receipt.created",
    countWhere((r) => r.action === "receipt.created"),
  );
  await expectFilter(
    "filter by actor: the owner",
    `actor=${ownerRecord.id}`,
    countWhere((r) => r.actor_id === ownerRecord.id),
  );
  await expectFilter(
    "filter by actor: the therapist",
    `actor=${staffId}`,
    countWhere((r) => r.actor_id === staffId),
  );
  await expectFilter("filter by date: a window in the future", "from=2099-01-01&to=2099-12-31", 0);
  await expectFilter(
    "filter by date: today",
    `from=${today}&to=${today}`,
    countWhere((r) => r.created_at.slice(0, 10) === today),
  );
  await expectFilter(
    "the three filters combine",
    `action=receipt.created&actor=${ownerRecord.id}&from=${today}&to=${today}`,
    countWhere(
      (r) =>
        r.action === "receipt.created" &&
        r.actor_id === ownerRecord.id &&
        r.created_at.slice(0, 10) === today,
    ),
  );

  const unfiltered = await get(owner, "/dashboard/audit");
  check(
    "the unfiltered view shows every entry",
    countRows(unfiltered.body) === Math.min(allRows.length, 50),
    `rendered ${countRows(unfiltered.body)} of ${allRows.length}`,
  );

/* ================================================================ */
  console.log("\nThe log cannot be rewritten\n");

  const target = allRows[0];

  // ...through the app's own client, as the owner.
  const ownerClient = createClient(
    SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  await ownerClient.auth.signInWithPassword({ email: ownerEmail, password: PASSWORD });

  const { error: ownerEdit } = await ownerClient
    .from("audit_logs")
    .update({ action: "tampered" })
    .eq("id", target.id)
    .select();
  const { data: afterOwnerEdit } = await admin
    .from("audit_logs")
    .select("action")
    .eq("id", target.id)
    .single();
  check(
    "the owner cannot edit an entry",
    afterOwnerEdit.action === target.action,
    ownerEdit?.message ?? "update matched no rows",
  );

  const { error: ownerDelete } = await ownerClient
    .from("audit_logs")
    .delete()
    .eq("id", target.id)
    .select();
  const { data: afterOwnerDelete } = await admin
    .from("audit_logs")
    .select("id")
    .eq("id", target.id)
    .maybeSingle();
  check(
    "the owner cannot delete an entry",
    Boolean(afterOwnerDelete),
    ownerDelete?.message ?? "delete matched no rows",
  );

  // ...and with the service-role key, which bypasses RLS entirely. This is the
  // case a policy alone does not cover, and why audit_logs carries a trigger.
  const { error: adminEdit } = await admin
    .from("audit_logs")
    .update({ action: "tampered" })
    .eq("id", target.id)
    .select();
  const { data: afterAdminEdit } = await admin
    .from("audit_logs")
    .select("action")
    .eq("id", target.id)
    .single();
  check(
    "the service-role key cannot edit an entry either",
    afterAdminEdit.action === target.action,
    adminEdit?.message?.slice(0, 80) ?? "no error raised",
  );

  const { error: adminDelete } = await admin
    .from("audit_logs")
    .delete()
    .eq("id", target.id)
    .select();
  const { data: afterAdminDelete } = await admin
    .from("audit_logs")
    .select("id")
    .eq("id", target.id)
    .maybeSingle();
  check(
    "nor delete one",
    Boolean(afterAdminDelete),
    adminDelete?.message?.slice(0, 80) ?? "no error raised",
  );

  const { error: adminInsertOther } = await ownerClient.from("audit_logs").insert({
    salon_id: SALON_ID,
    actor_id: staffId,
    action: "forged.entry",
  });
  check(
    "an entry cannot be forged against another actor",
    Boolean(adminInsertOther),
    adminInsertOther?.message?.slice(0, 60),
  );

  /* ================================================================ */
  console.log("\nCoverage of the action vocabulary\n");

  // Every action string the application declares should be reachable. One that
  // never fires is either dead code or a feature that quietly is not audited.
  const DECLARED = [
    "salon.created", "salon.settings_changed",
    "staff.invited", "staff.invite_revoked", "staff.invite_accepted",
    "staff.role_changed", "staff.deactivated", "staff.reactivated",
    "service.created", "service.updated", "service.archived", "service.restored",
    "deal.created", "deal.updated", "deal.archived",
    "consent_template.created", "consent_template.updated", "consent_template.archived",
    "customer.created", "customer.updated",
    "consent_form.created", "consent_form.viewed",
    "appointment.booked", "appointment.rescheduled", "appointment.confirmed",
    "appointment.completed", "appointment.cancelled", "appointment.no_show",
    "receipt.created", "receipt.voided", "loyalty.redeemed",
    "payroll.generated", "payroll.marked_paid", "payroll.commission_rate_changed",
  ];

  const distinctActions = new Set((await auditRows()).map((r) => r.action));
  const unseen = DECLARED.filter((a) => !distinctActions.has(a));
  console.log(
    `  ${distinctActions.size} of ${DECLARED.length} declared actions fired during this run`,
  );
  if (unseen.length > 0) {
    console.log(`  not exercised: ${unseen.join(", ")}`);
  }
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (missing.length > 0) {
      console.log(`Actions that did not fire: ${[...new Set(missing)].join(", ")}\n`);
    }
    process.exitCode = failed === 0 ? 0 : 1;
  })
  .catch(async (error) => {
    await cleanup();
    console.error("\nTest run aborted:", error.message, "\n");
    process.exitCode = 1;
  });
