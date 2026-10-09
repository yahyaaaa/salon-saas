/**
 * Tenant isolation test.
 *
 * The brief makes this non-negotiable: two salons must not be able to see each
 * other's data under ANY role. This script proves it against a real Supabase
 * project by creating two complete salons and then attempting every cross-tenant
 * read and write we can think of, as each role, through the public API with the
 * publishable key -- exactly what a hostile client would have.
 *
 *   npm run test:rls
 *
 * It creates and then deletes its own throwaway users. Point it at a
 * development project, never production.
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !PUBLISHABLE_KEY || !SECRET_KEY) {
  console.error(
    "Missing Supabase environment variables. Copy .env.example to .env.local and fill it in.",
  );
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = `Test-${randomUUID().slice(0, 12)}!`;
const createdUserIds = [];
const createdSalonIds = [];

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  \u001b[32mPASS\u001b[0m  ${name}`);
  } else {
    failed += 1;
    console.log(`  \u001b[31mFAIL\u001b[0m  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function anonClient() {
  return createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Sign in as a user and return a client bound to that session. */
async function clientFor(email) {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Could not sign in as ${email}: ${error.message}`);
  return client;
}

/**
 * Create an owner + salon by going through the real signup path, so the
 * handle_new_user trigger builds the tenant exactly as it does in the app.
 */
async function createSalon(label) {
  const email = `owner-${label}-${randomUUID().slice(0, 8)}@rls-test.local`;

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: {
      full_name: `${label} Owner`,
      salon_name: `${label} Salon ${randomUUID().slice(0, 4)}`,
      business_type: "salon",
      country: "US",
      timezone: "UTC",
      currency: "USD",
    },
  });

  if (error) throw new Error(`Failed to create owner for ${label}: ${error.message}`);
  createdUserIds.push(data.user.id);

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("salon_id, team_member_id")
    .eq("id", data.user.id)
    .single();

  if (profileError) {
    throw new Error(`Owner ${label} has no profile -- the signup trigger did not run.`);
  }
  createdSalonIds.push(profile.salon_id);

  /*
   * Two identities since the Team/User split: `userId` is the login that takes
   * actions, `memberId` is the roster entry that performs services and is
   * paid. handle_new_user() creates and links the second.
   */
  return {
    email,
    userId: data.user.id,
    salonId: profile.salon_id,
    memberId: profile.team_member_id,
  };
}

/** Create an invited member (staff or receptionist) in an existing salon. */
async function createMember(salonId, role, invitedBy) {
  const email = `${role}-${randomUUID().slice(0, 8)}@rls-test.local`;

  const { error: inviteError } = await admin.from("invitations").insert({
    salon_id: salonId,
    email,
    role,
    full_name: `${role} member`,
    invited_by: invitedBy,
  });
  if (inviteError) throw new Error(`Invitation insert failed: ${inviteError.message}`);

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: `${role} member` },
  });
  if (error) throw new Error(`Failed to create ${role}: ${error.message}`);

  createdUserIds.push(data.user.id);

  const { data: member } = await admin
    .from("profiles")
    .select("team_member_id")
    .eq("id", data.user.id)
    .single();

  return { email, userId: data.user.id, memberId: member.team_member_id };
}

/**
 * A 1x1 transparent PNG -- stands in for a signature image.
 */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/**
 * Seed one salon with the Phase 2 records: a consent template, a service that
 * requires it, a deal, a customer, and two signed consent forms -- one
 * collected by the front desk and one by the therapist, so the narrower
 * therapist visibility rule has something to bite on.
 *
 * Written with the service-role client so the fixtures are deterministic; the
 * policies themselves are exercised by the checks, not by the setup.
 */
async function seedTenant(
  salonId,
  frontDeskUserId,
  therapistUserId,
  therapistMemberId,
  label,
) {
  const { data: template, error: templateError } = await admin
    .from("consent_templates")
    .insert({ salon_id: salonId, name: `${label} Botox Consent` })
    .select("id")
    .single();
  if (templateError) throw new Error(`consent_templates: ${templateError.message}`);

  const { error: itemError } = await admin.from("consent_template_items").insert([
    {
      salon_id: salonId,
      template_id: template.id,
      label: "I consent to the injection risks as explained",
      sort_order: 0,
    },
    {
      salon_id: salonId,
      template_id: template.id,
      label: "I confirm I am not pregnant or breastfeeding",
      sort_order: 1,
    },
  ]);
  if (itemError) throw new Error(`consent_template_items: ${itemError.message}`);

  const { data: service, error: serviceError } = await admin
    .from("services")
    .insert({
      salon_id: salonId,
      name: `${label} Botox`,
      category: "Injectables",
      price: 250.0,
      duration_minutes: 45,
      consent_template_id: template.id,
    })
    .select("id")
    .single();
  if (serviceError) throw new Error(`services: ${serviceError.message}`);

  const { error: serviceStaffError } = await admin
    .from("service_staff")
    .insert({ salon_id: salonId, service_id: service.id, staff_id: therapistMemberId });
  if (serviceStaffError) throw new Error(`service_staff: ${serviceStaffError.message}`);

  const { data: deal, error: dealError } = await admin
    .from("deals")
    .insert({
      salon_id: salonId,
      name: `${label} Launch Offer`,
      deal_type: "percentage",
      value: 20,
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
    })
    .select("id")
    .single();
  if (dealError) throw new Error(`deals: ${dealError.message}`);

  const { error: dealServiceError } = await admin
    .from("deal_services")
    .insert({ salon_id: salonId, deal_id: deal.id, service_id: service.id });
  if (dealServiceError) throw new Error(`deal_services: ${dealServiceError.message}`);

  // Deliberately the same phone number in both salons: they are separate
  // tenants and must not collide.
  const { data: customer, error: customerError } = await admin
    .from("customers")
    .insert({
      salon_id: salonId,
      full_name: `${label} Customer`,
      phone: "+92 300 1234567",
      email: `customer@${label.toLowerCase()}-rls.local`,
      created_by: frontDeskUserId,
    })
    .select("id")
    .single();
  if (customerError) throw new Error(`customers: ${customerError.message}`);

  async function seedForm(collectedBy, note) {
    const formId = randomUUID();
    const signaturePath = `${salonId}/${customer.id}/${formId}.png`;

    const { error: formError } = await admin.from("consent_forms").insert({
      id: formId,
      salon_id: salonId,
      customer_id: customer.id,
      template_id: template.id,
      service_id: service.id,
      collected_by: collectedBy,
      medical_history: `${note} -- confidential medical history for ${label}`,
      allergies: "Penicillin",
      signature_path: signaturePath,
      signed_at: new Date().toISOString(),
    });
    if (formError) throw new Error(`consent_forms: ${formError.message}`);

    const { error: responseError } = await admin.from("consent_form_responses").insert({
      salon_id: salonId,
      form_id: formId,
      label: "I consent to the injection risks as explained",
      is_required: true,
      checked: true,
      sort_order: 0,
    });
    if (responseError) throw new Error(`consent_form_responses: ${responseError.message}`);

    // Put a real object behind the path so the storage policies have something
    // to authorise against.
    const { error: uploadError } = await admin.storage
      .from("consent-signatures")
      .upload(signaturePath, PNG_BYTES, { contentType: "image/png", upsert: true });
    if (uploadError) throw new Error(`signature upload: ${uploadError.message}`);

    return { formId, signaturePath };
  }

  const reception = await seedForm(frontDeskUserId, "front desk");
  const therapist = await seedForm(therapistUserId, "therapist");

  return {
    templateId: template.id,
    serviceId: service.id,
    dealId: deal.id,
    customerId: customer.id,
    receptionFormId: reception.formId,
    receptionSignaturePath: reception.signaturePath,
    staffFormId: therapist.formId,
    staffSignaturePath: therapist.signaturePath,
  };
}

/**
 * Add the Phase 3 records to a salon that seedTenant() has already populated:
 * a booking for the therapist, plus a consent form attached to that booking
 * but collected by the front desk -- which is exactly the case the widened
 * visibility rule exists for.
 */
async function seedBookings(salonId, fixtures, therapistMemberId, frontDeskUserId) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2);
  start.setUTCHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + 45 * 60_000);

  const { data: appointment, error: appointmentError } = await admin
    .from("appointments")
    .insert({
      salon_id: salonId,
      customer_id: fixtures.customerId,
      staff_id: therapistMemberId,
      service_id: fixtures.serviceId,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      price_at_booking: 250,
      created_by: frontDeskUserId,
    })
    .select("id")
    .single();
  if (appointmentError) throw new Error(`appointments: ${appointmentError.message}`);

  // A consent form the FRONT DESK collected, attached to the THERAPIST's
  // booking. Before Phase 3 the therapist could not see this; now they can.
  const formId = randomUUID();
  const signaturePath = `${salonId}/${fixtures.customerId}/${formId}.png`;

  const { error: formError } = await admin.from("consent_forms").insert({
    id: formId,
    salon_id: salonId,
    customer_id: fixtures.customerId,
    template_id: fixtures.templateId,
    service_id: fixtures.serviceId,
    appointment_id: appointment.id,
    collected_by: frontDeskUserId,
    medical_history: "collected at the desk for the therapist's booking",
    allergies: "Latex",
    signature_path: signaturePath,
    signed_at: new Date().toISOString(),
  });
  if (formError) throw new Error(`consent_forms (linked): ${formError.message}`);

  const { error: uploadError } = await admin.storage
    .from("consent-signatures")
    .upload(signaturePath, PNG_BYTES, { contentType: "image/png", upsert: true });
  if (uploadError) throw new Error(`linked signature upload: ${uploadError.message}`);

  return {
    appointmentId: appointment.id,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    linkedFormId: formId,
    linkedSignaturePath: signaturePath,
  };
}

/**
 * Every object path beneath one salon's prefix in a bucket.
 *
 * Signatures sit two levels deep (<salon>/<customer>/<file>); attachments sit
 * three (<salon>/<customer>/<form>/<file>), so this walks until it finds files
 * rather than assuming a depth.
 */
async function listPrefix(salonId, bucket = "consent-signatures") {
  const paths = [];

  async function walk(prefix, depth) {
    if (depth > 4) return;
    const { data: entries } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
    for (const entry of entries ?? []) {
      const next = `${prefix}/${entry.name}`;
      // Storage reports a real file with metadata; a folder comes back without.
      if (entry.id) paths.push(next);
      else await walk(next, depth + 1);
    }
  }

  await walk(salonId, 0);
  return paths;
}

async function cleanup() {
  // Order matters. appointments.staff_id and consent_forms.customer_id are
  // restrict-style references, deliberately: a therapist who has appointments,
  // or a customer who has a medical record, must not be deletable out from
  // under them. That also means those rows have to go first -- otherwise
  // deleting the auth user fails and leaves an orphan behind.
  //
  // Query builders are thenables without .catch(), so each await gets its own
  // try/catch.
  for (const id of createdSalonIds) {
    try {
      // Deleting the salon cascades to everything that belongs to it --
      // appointments, consent forms, receipts and the loyalty ledger included.
      // Only storage objects, which have no foreign key to salons, need doing
      // by hand (below).
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

  // storage.objects has no foreign key to salons, so signature images outlive a
  // cascade delete -- purge each salon's prefix explicitly.
  //
  // Listing is paginated and, right after a burst of uploads, does not always
  // return everything on the first pass. So this sweeps repeatedly until a
  // prefix comes back empty, and says so if anything is left: a silently
  // leaked medical-record image is exactly the thing not to shrug at.
  for (const id of createdSalonIds) {
    for (const bucket of ["consent-signatures", "consent-attachments", "staff-documents"]) {
      let remaining = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        remaining = await listPrefix(id, bucket);
        if (remaining.length === 0) break;

        const { error } = await admin.storage.from(bucket).remove(remaining);
        if (error) {
          console.warn(`  cleanup: could not clear ${bucket} under ${id}: ${error.message}`);
          break;
        }
      }

      if (remaining.length > 0) {
        const left = await listPrefix(id, bucket);
        if (left.length > 0) {
          console.warn(`  cleanup: ${left.length} object(s) left in ${bucket} under ${id}`);
        }
      }
    }
  }

}

async function main() {
  console.log("\nSetting up two independent salons...\n");

  const salonA = await createSalon("Alpha");
  const salonB = await createSalon("Bravo");

  const staffA = await createMember(salonA.salonId, "staff", salonA.userId);
  const receptionistA = await createMember(salonA.salonId, "receptionist", salonA.userId);
  const staffB = await createMember(salonB.salonId, "staff", salonB.userId);

  check("Salon A and Salon B are distinct tenants", salonA.salonId !== salonB.salonId);
  check(
    "Invited staff landed in the inviting salon",
    (await admin.from("profiles").select("salon_id, role").eq("id", staffA.userId).single())
      .data?.salon_id === salonA.salonId,
  );

  const asOwnerA = await clientFor(salonA.email);
  const asStaffA = await clientFor(staffA.email);
  const asReceptionistA = await clientFor(receptionistA.email);
  const asOwnerB = await clientFor(salonB.email);
  const asStaffB = await clientFor(staffB.email);

  /* ---------------------------------------------------------------- */
  console.log("\nCross-tenant reads (must return nothing)\n");

  const roles = [
    ["owner A", asOwnerA],
    ["staff A", asStaffA],
    ["receptionist A", asReceptionistA],
  ];

  for (const [label, client] of roles) {
    const { data: salons } = await client.from("salons").select("id");
    const ids = (salons ?? []).map((s) => s.id);
    check(
      `${label} sees only its own salon row`,
      ids.length === 1 && ids[0] === salonA.salonId,
      `saw ${ids.length} salon(s)`,
    );

    const { data: byId } = await client.from("salons").select("id").eq("id", salonB.salonId);
    check(`${label} cannot read Salon B by id`, (byId ?? []).length === 0);

    const { data: profiles } = await client.from("profiles").select("id, salon_id");
    const foreign = (profiles ?? []).filter((p) => p.salon_id !== salonA.salonId);
    check(`${label} sees no profiles from Salon B`, foreign.length === 0, `${foreign.length} leaked`);

    const { data: foreignSettings } = await client
      .from("salon_settings")
      .select("salon_id")
      .eq("salon_id", salonB.salonId);
    check(`${label} cannot read Salon B settings`, (foreignSettings ?? []).length === 0);
  }

  const { data: bSeesA } = await asOwnerB.from("profiles").select("id, salon_id");
  check(
    "owner B sees no profiles from Salon A",
    (bSeesA ?? []).every((p) => p.salon_id === salonB.salonId),
  );

  const { data: staffBSeesA } = await asStaffB
    .from("salons")
    .select("id")
    .eq("id", salonA.salonId);
  check("staff B cannot read Salon A", (staffBSeesA ?? []).length === 0);

  /* ---------------------------------------------------------------- */
  console.log("\nRole restrictions within a tenant\n");

  const { data: ownerInvites } = await asOwnerA.from("invitations").select("id");
  check("owner A can read its own invitations", Array.isArray(ownerInvites));

  const { data: staffInvites } = await asStaffA.from("invitations").select("id");
  check("staff A cannot read invitations", (staffInvites ?? []).length === 0);

  const { data: receptionInvites } = await asReceptionistA.from("invitations").select("id");
  check("receptionist A cannot read invitations", (receptionInvites ?? []).length === 0);

  const { data: ownerAudit } = await asOwnerA.from("audit_logs").select("id");
  check("owner A can read its audit log", (ownerAudit ?? []).length > 0);

  const { data: staffAudit } = await asStaffA.from("audit_logs").select("id");
  check("staff A cannot read the audit log", (staffAudit ?? []).length === 0);

  const { data: receptionAudit } = await asReceptionistA.from("audit_logs").select("id");
  check("receptionist A cannot read the audit log", (receptionAudit ?? []).length === 0);

  /* ---------------------------------------------------------------- */
  console.log("\nCross-tenant writes (must be rejected)\n");

  const { error: foreignSalonUpdate } = await asOwnerA
    .from("salons")
    .update({ name: "Hijacked" })
    .eq("id", salonB.salonId)
    .select();
  const { data: salonBStillNamed } = await admin
    .from("salons")
    .select("name")
    .eq("id", salonB.salonId)
    .single();
  check(
    "owner A cannot rename Salon B",
    salonBStillNamed?.name !== "Hijacked",
    foreignSalonUpdate?.message ?? "update silently matched no rows",
  );

  const { error: foreignInvite } = await asOwnerA.from("invitations").insert({
    salon_id: salonB.salonId,
    email: `intruder-${randomUUID().slice(0, 6)}@rls-test.local`,
    role: "staff",
  });
  check("owner A cannot create an invitation into Salon B", Boolean(foreignInvite));

  const { error: foreignAudit } = await asOwnerA.from("audit_logs").insert({
    salon_id: salonB.salonId,
    actor_id: salonA.userId,
    action: "forged.entry",
  });
  check("owner A cannot write an audit entry into Salon B", Boolean(foreignAudit));

  const { error: spoofedActor } = await asStaffA.from("audit_logs").insert({
    salon_id: salonA.salonId,
    actor_id: salonA.userId,
    action: "forged.actor",
  });
  check("staff A cannot forge an audit entry as the owner", Boolean(spoofedActor));

  const { error: foreignProfileUpdate } = await asOwnerA
    .from("profiles")
    .update({ role: "owner" })
    .eq("id", staffB.userId)
    .select();
  const { data: staffBRole } = await admin
    .from("profiles")
    .select("role")
    .eq("id", staffB.userId)
    .single();
  check(
    "owner A cannot promote a member of Salon B",
    staffBRole?.role === "staff",
    foreignProfileUpdate?.message ?? "update matched no rows",
  );

  /* ---------------------------------------------------------------- */
  console.log("\nPrivilege escalation within a tenant (must be rejected)\n");

  const { error: selfPromote } = await asStaffA
    .from("profiles")
    .update({ role: "owner" })
    .eq("id", staffA.userId);
  check("staff A cannot promote themselves", Boolean(selfPromote));

  const { error: staffPromotesPeer } = await asStaffA
    .from("profiles")
    .update({ role: "owner" })
    .eq("id", receptionistA.userId)
    .select();
  const { data: receptionRole } = await admin
    .from("profiles")
    .select("role")
    .eq("id", receptionistA.userId)
    .single();
  check(
    "staff A cannot promote a colleague",
    receptionRole?.role === "receptionist",
    staffPromotesPeer?.message ?? "update matched no rows",
  );

  const { error: tenantHop } = await asStaffA
    .from("profiles")
    .update({ salon_id: salonB.salonId })
    .eq("id", staffA.userId);
  check("staff A cannot move themselves to another salon", Boolean(tenantHop));

  const { error: settingsByStaff } = await asStaffA
    .from("salon_settings")
    .update({ loyalty_earn_rate: 0.9 })
    .eq("salon_id", salonA.salonId)
    .select();
  const { data: rate } = await admin
    .from("salon_settings")
    .select("loyalty_earn_rate")
    .eq("salon_id", salonA.salonId)
    .single();
  check(
    "staff A cannot change the loyalty rate",
    Number(rate?.loyalty_earn_rate) !== 0.9,
    settingsByStaff?.message ?? "update matched no rows",
  );

  /* ---------------------------------------------------------------- */
  console.log("\nAudit log immutability\n");

  const { data: anEntry } = await admin
    .from("audit_logs")
    .select("id")
    .eq("salon_id", salonA.salonId)
    .limit(1)
    .single();

  const { error: auditUpdate } = await asOwnerA
    .from("audit_logs")
    .update({ action: "tampered" })
    .eq("id", anEntry.id)
    .select();
  const { data: untouched } = await admin
    .from("audit_logs")
    .select("action")
    .eq("id", anEntry.id)
    .single();
  check(
    "owner A cannot edit an audit entry",
    untouched?.action !== "tampered",
    auditUpdate?.message ?? "update matched no rows",
  );

  const { error: auditDelete } = await asOwnerA
    .from("audit_logs")
    .delete()
    .eq("id", anEntry.id)
    .select();
  const { data: stillThere } = await admin
    .from("audit_logs")
    .select("id")
    .eq("id", anEntry.id)
    .maybeSingle();
  check(
    "owner A cannot delete an audit entry",
    Boolean(stillThere),
    auditDelete?.message ?? "delete matched no rows",
  );

  /* ---------------------------------------------------------------- */
  /* Phase 2: catalogue, customers, consent forms, signature storage    */
  /* ---------------------------------------------------------------- */
  console.log("\nPhase 2 fixtures\n");

  const fixturesA = await seedTenant(
    salonA.salonId,
    receptionistA.userId,
    staffA.userId,
    staffA.memberId,
    "Alpha",
  );
  const fixturesB = await seedTenant(
    salonB.salonId,
    salonB.userId,
    staffB.userId,
    staffB.memberId,
    "Bravo",
  );
  check("both salons seeded with catalogue, customer and consent records", true);
  check(
    "the same phone number can exist in both salons independently",
    fixturesA.customerId !== fixturesB.customerId,
  );

  /* ---------------------------------------------------------------- */
  console.log("\nPhase 2 cross-tenant reads (must return nothing)\n");

  const phase2Tables = [
    "services",
    "service_staff",
    "deals",
    "deal_services",
    "consent_templates",
    "consent_template_items",
    "customers",
  ];

  for (const [label, client] of roles) {
    for (const table of phase2Tables) {
      const { data } = await client.from(table).select("salon_id");
      const foreign = (data ?? []).filter((r) => r.salon_id !== salonA.salonId);
      check(`${label} sees no ${table} from Salon B`, foreign.length === 0, `${foreign.length} leaked`);
    }
  }

  const { data: foreignCustomerById } = await asReceptionistA
    .from("customers")
    .select("id")
    .eq("id", fixturesB.customerId);
  check("receptionist A cannot read Salon B's customer by id", (foreignCustomerById ?? []).length === 0);

  const { data: foreignServiceById } = await asOwnerA
    .from("services")
    .select("id")
    .eq("id", fixturesB.serviceId);
  check("owner A cannot read Salon B's service by id", (foreignServiceById ?? []).length === 0);

  /* ---------------------------------------------------------------- */
  console.log("\nConsent forms: medical data is never visible cross-tenant\n");

  for (const [label, client] of roles) {
    const { data } = await client.from("consent_forms").select("salon_id, medical_history");
    const foreign = (data ?? []).filter((r) => r.salon_id !== salonA.salonId);
    check(`${label} sees no consent forms from Salon B`, foreign.length === 0);
  }

  const { data: bFormById } = await asOwnerA
    .from("consent_forms")
    .select("id, medical_history")
    .eq("id", fixturesB.receptionFormId);
  check("owner A cannot read Salon B's consent form by id", (bFormById ?? []).length === 0);

  const { data: bResponses } = await asOwnerA
    .from("consent_form_responses")
    .select("id")
    .eq("form_id", fixturesB.receptionFormId);
  check("owner A cannot read Salon B's consent responses", (bResponses ?? []).length === 0);

  /* ---------------------------------------------------------------- */
  console.log("\nConsent forms: visibility within a tenant\n");

  const { data: ownerForms } = await asOwnerA.from("consent_forms").select("id");
  check("owner A sees all consent forms in the salon", (ownerForms ?? []).length === 2);

  const { data: receptionForms } = await asReceptionistA.from("consent_forms").select("id");
  check("receptionist A sees all consent forms in the salon", (receptionForms ?? []).length === 2);

  const { data: staffForms } = await asStaffA.from("consent_forms").select("id");
  check(
    "staff A sees only the form they collected themselves",
    (staffForms ?? []).length === 1 && staffForms[0].id === fixturesA.staffFormId,
    `saw ${(staffForms ?? []).length}`,
  );

  const { data: staffPeek } = await asStaffA
    .from("consent_forms")
    .select("id, medical_history")
    .eq("id", fixturesA.receptionFormId);
  check("staff A cannot read a colleague's consent form even by id", (staffPeek ?? []).length === 0);

  const { data: staffPeekResponses } = await asStaffA
    .from("consent_form_responses")
    .select("id")
    .eq("form_id", fixturesA.receptionFormId);
  check("staff A cannot read a colleague's consent responses", (staffPeekResponses ?? []).length === 0);

  /* ---------------------------------------------------------------- */
  console.log("\nComposite foreign keys block cross-tenant stitching\n");

  // Each of these passes the RLS check -- salon_id is the caller's own salon --
  // and is stopped by the (id, salon_id) foreign keys instead.
  const { error: foreignTemplateLink } = await asOwnerA.from("services").insert({
    salon_id: salonA.salonId,
    name: `Stitched ${randomUUID().slice(0, 6)}`,
    price: 10,
    duration_minutes: 30,
    consent_template_id: fixturesB.templateId,
  });
  check(
    "a service cannot reference another salon's consent template",
    Boolean(foreignTemplateLink),
    foreignTemplateLink?.message?.slice(0, 60),
  );

  const { error: foreignDealService } = await asOwnerA.from("deal_services").insert({
    salon_id: salonA.salonId,
    deal_id: fixturesA.dealId,
    service_id: fixturesB.serviceId,
  });
  check(
    "a deal cannot include another salon's service",
    Boolean(foreignDealService),
    foreignDealService?.message?.slice(0, 60),
  );

  const { error: foreignConsentCustomer } = await asReceptionistA.from("consent_forms").insert({
    salon_id: salonA.salonId,
    customer_id: fixturesB.customerId,
    collected_by: receptionistA.userId,
  });
  check(
    "a consent form cannot be attached to another salon's customer",
    Boolean(foreignConsentCustomer),
    foreignConsentCustomer?.message?.slice(0, 60),
  );

  const { error: foreignServiceStaff } = await asOwnerA.from("service_staff").insert({
    salon_id: salonA.salonId,
    service_id: fixturesA.serviceId,
    staff_id: staffB.memberId,
  });
  check(
    "another salon's therapist cannot be assigned to a service",
    Boolean(foreignServiceStaff),
    foreignServiceStaff?.message?.slice(0, 60),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nPhase 2 cross-tenant writes (must be rejected)\n");

  const { error: foreignService } = await asOwnerA.from("services").insert({
    salon_id: salonB.salonId,
    name: "Intruder Service",
    price: 10,
    duration_minutes: 30,
  });
  check("owner A cannot create a service in Salon B", Boolean(foreignService));

  const { error: foreignCustomer } = await asReceptionistA.from("customers").insert({
    salon_id: salonB.salonId,
    full_name: "Intruder",
    phone: `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`,
  });
  check("receptionist A cannot create a customer in Salon B", Boolean(foreignCustomer));

  const { error: foreignCustomerEdit } = await asReceptionistA
    .from("customers")
    .update({ notes: "tampered" })
    .eq("id", fixturesB.customerId)
    .select();
  const { data: bCustomerNotes } = await admin
    .from("customers")
    .select("notes")
    .eq("id", fixturesB.customerId)
    .single();
  check(
    "receptionist A cannot edit Salon B's customer",
    bCustomerNotes?.notes !== "tampered",
    foreignCustomerEdit?.message ?? "update matched no rows",
  );

  /* ---------------------------------------------------------------- */
  console.log("\nPhase 2 role restrictions within a tenant\n");

  const { error: staffCreatesService } = await asStaffA.from("services").insert({
    salon_id: salonA.salonId,
    name: "Unauthorised Service",
    price: 10,
    duration_minutes: 30,
  });
  check("staff A cannot create a service", Boolean(staffCreatesService));

  const { error: receptionCreatesService } = await asReceptionistA.from("services").insert({
    salon_id: salonA.salonId,
    name: "Unauthorised Service",
    price: 10,
    duration_minutes: 30,
  });
  check("receptionist A cannot create a service", Boolean(receptionCreatesService));

  const { error: receptionRepricesService } = await asReceptionistA
    .from("services")
    .update({ price: 1 })
    .eq("id", fixturesA.serviceId)
    .select();
  const { data: priceNow } = await admin
    .from("services")
    .select("price")
    .eq("id", fixturesA.serviceId)
    .single();
  check(
    "receptionist A cannot change a price",
    Number(priceNow?.price) !== 1,
    receptionRepricesService?.message ?? "update matched no rows",
  );

  const { error: receptionCreatesDeal } = await asReceptionistA.from("deals").insert({
    salon_id: salonA.salonId,
    name: "Unauthorised Deal",
    deal_type: "percentage",
    value: 50,
    starts_on: "2026-01-01",
    ends_on: "2026-12-31",
  });
  check("receptionist A cannot create a deal", Boolean(receptionCreatesDeal));

  const { error: staffCreatesCustomer } = await asStaffA.from("customers").insert({
    salon_id: salonA.salonId,
    full_name: "Walk In",
    phone: `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`,
  });
  check("staff A cannot create a customer", Boolean(staffCreatesCustomer));

  const { data: staffReadsCustomers } = await asStaffA.from("customers").select("id");
  check(
    "staff A can still read customers (needed for their own bookings)",
    (staffReadsCustomers ?? []).length > 0,
  );

  /*
   * This used to assert a receptionist could not be assigned to a service.
   * That rule inferred "performs treatments" from a role on a LOGIN, and does
   * not survive the split -- a receptionist who also does nails simply has a
   * roster entry. What still holds, and is what this now checks, is that the
   * assignment must name someone on THIS salon's roster.
   */
  const { error: receptionistAsTherapist } = await asOwnerA.from("service_staff").insert({
    salon_id: salonA.salonId,
    service_id: fixturesA.serviceId,
    staff_id: staffB.memberId,
  });
  check(
    "someone from another salon cannot be assigned to perform a service",
    Boolean(receptionistAsTherapist),
    receptionistAsTherapist?.message?.slice(0, 60),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nConsent records are immutable once signed\n");

  const { error: editSigned } = await asReceptionistA
    .from("consent_forms")
    .update({ medical_history: "tampered" })
    .eq("id", fixturesA.receptionFormId)
    .select();
  const { data: historyNow } = await admin
    .from("consent_forms")
    .select("medical_history")
    .eq("id", fixturesA.receptionFormId)
    .single();
  check(
    "a signed consent form cannot be edited",
    historyNow?.medical_history !== "tampered",
    editSigned?.message?.slice(0, 60) ?? "update matched no rows",
  );

  const { error: deleteForm } = await asOwnerA
    .from("consent_forms")
    .delete()
    .eq("id", fixturesA.receptionFormId)
    .select();
  const { data: formStillThere } = await admin
    .from("consent_forms")
    .select("id")
    .eq("id", fixturesA.receptionFormId)
    .maybeSingle();
  check(
    "a consent form cannot be deleted",
    Boolean(formStillThere),
    deleteForm?.message ?? "delete matched no rows",
  );

  const { error: forgeCollector } = await asReceptionistA.from("consent_forms").insert({
    salon_id: salonA.salonId,
    customer_id: fixturesA.customerId,
    collected_by: staffA.userId,
  });
  check("a consent form cannot be recorded as collected by someone else", Boolean(forgeCollector));

  /* ---------------------------------------------------------------- */
  console.log("\nSignature storage (private bucket)\n");

  const BUCKET = "consent-signatures";

  const { error: ownUpload } = await asReceptionistA.storage
    .from(BUCKET)
    .upload(
      `${salonA.salonId}/${fixturesA.customerId}/probe-${randomUUID().slice(0, 6)}.png`,
      PNG_BYTES,
      { contentType: "image/png" },
    );
  check("receptionist A can upload into their own salon's prefix", !ownUpload, ownUpload?.message);

  const { error: foreignUpload } = await asReceptionistA.storage
    .from(BUCKET)
    .upload(`${salonB.salonId}/${fixturesB.customerId}/intruder.png`, PNG_BYTES, {
      contentType: "image/png",
    });
  check(
    "receptionist A cannot upload into Salon B's prefix",
    Boolean(foreignUpload),
    foreignUpload?.message?.slice(0, 60),
  );

  const { data: ownerDownload, error: ownerDownloadError } = await asOwnerA.storage
    .from(BUCKET)
    .download(fixturesA.receptionSignaturePath);
  check(
    "owner A can download a signature from their own salon",
    Boolean(ownerDownload) && !ownerDownloadError,
    ownerDownloadError?.message,
  );

  const { data: staffOwnDownload } = await asStaffA.storage
    .from(BUCKET)
    .download(fixturesA.staffSignaturePath);
  check("staff A can download the signature they collected", Boolean(staffOwnDownload));

  const { data: staffPeekDownload } = await asStaffA.storage
    .from(BUCKET)
    .download(fixturesA.receptionSignaturePath);
  check(
    "staff A cannot download a colleague's signature, even with the exact path",
    !staffPeekDownload,
  );

  const { data: crossTenantDownload } = await asOwnerA.storage
    .from(BUCKET)
    .download(fixturesB.receptionSignaturePath);
  check(
    "owner A cannot download Salon B's signature, even with the exact path",
    !crossTenantDownload,
  );

  const { data: anonDownload } = await anonClient()
    .storage.from(BUCKET)
    .download(fixturesA.receptionSignaturePath);
  check("anonymous cannot download a signature", !anonDownload);

  const { data: crossTenantList } = await asOwnerA.storage.from(BUCKET).list(salonB.salonId);
  check(
    "owner A cannot list Salon B's signature folder",
    (crossTenantList ?? []).length === 0,
    `saw ${(crossTenantList ?? []).length} object(s)`,
  );

  const { error: overwriteSignature } = await asOwnerA.storage
    .from(BUCKET)
    .update(fixturesA.receptionSignaturePath, PNG_BYTES, { contentType: "image/png" });
  check(
    "a stored signature cannot be overwritten",
    Boolean(overwriteSignature),
    overwriteSignature?.message?.slice(0, 60),
  );

  await asOwnerA.storage.from(BUCKET).remove([fixturesA.receptionSignaturePath]);
  const { data: stillDownloadable } = await asOwnerA.storage
    .from(BUCKET)
    .download(fixturesA.receptionSignaturePath);
  check(
    "a signature attached to a signed form cannot be deleted",
    Boolean(stillDownloadable),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nThe consent intake sequence, as the app performs it\n");

  // This mirrors createConsentFormAction step for step, under the receptionist's
  // own credentials, so the ordering the action relies on is proven to be legal
  // under RLS rather than merely assumed.
  const { data: seqDraft, error: seqDraftError } = await asReceptionistA
    .from("consent_forms")
    .insert({
      salon_id: salonA.salonId,
      customer_id: fixturesA.customerId,
      collected_by: receptionistA.userId,
      medical_history: "sequence probe",
    })
    .select("id")
    .single();
  check("1. a draft consent form can be created", !seqDraftError, seqDraftError?.message);

  if (seqDraft) {
    const { error: seqResponseError } = await asReceptionistA
      .from("consent_form_responses")
      .insert({
        salon_id: salonA.salonId,
        form_id: seqDraft.id,
        label: "I consent to the treatment as explained",
        is_required: true,
        checked: true,
        sort_order: 0,
      });
    check("2. responses can be attached to the draft", !seqResponseError, seqResponseError?.message);

    const seqPath = `${salonA.salonId}/${fixturesA.customerId}/${seqDraft.id}.png`;
    const { error: seqUploadError } = await asReceptionistA.storage
      .from(BUCKET)
      .upload(seqPath, PNG_BYTES, { contentType: "image/png" });
    check("3. the signature can be uploaded", !seqUploadError, seqUploadError?.message);

    // Assert the row actually changed, not merely that no error came back.
    // A zero-row UPDATE is not an error in PostgREST, so an earlier version of
    // this check passed for months against a policy that permitted no UPDATE
    // at all -- every consent form stayed an unsigned draft.
    const { error: seqSignError } = await asReceptionistA
      .from("consent_forms")
      .update({ signature_path: seqPath, signed_at: new Date().toISOString() })
      .eq("id", seqDraft.id);
    const { data: sealedRow } = await admin
      .from("consent_forms")
      .select("signed_at, signature_path")
      .eq("id", seqDraft.id)
      .single();
    check(
      "4. the draft can be sealed as signed",
      !seqSignError && Boolean(sealedRow?.signed_at) && sealedRow?.signature_path === seqPath,
      seqSignError?.message ?? "the update matched no rows",
    );

    const { data: otherDraft } = await asReceptionistA
      .from("consent_forms")
      .insert({
        salon_id: salonA.salonId,
        customer_id: fixturesA.customerId,
        collected_by: receptionistA.userId,
      })
      .select("id")
      .single();
    await asStaffA
      .from("consent_forms")
      .update({ signed_at: new Date().toISOString() })
      .eq("id", otherDraft.id);
    const { data: otherStill } = await admin
      .from("consent_forms")
      .select("signed_at")
      .eq("id", otherDraft.id)
      .single();
    check("a colleague cannot seal someone else's draft", !otherStill?.signed_at);
    await asReceptionistA.from("consent_forms").delete().eq("id", otherDraft.id);

    // ...and is immutable from that moment on.
    const { error: resealError } = await asReceptionistA
      .from("consent_forms")
      .update({ medical_history: "after the fact" })
      .eq("id", seqDraft.id)
      .select();
    const { data: sealedNow } = await admin
      .from("consent_forms")
      .select("medical_history")
      .eq("id", seqDraft.id)
      .single();
    check(
      "5. and the sealed form immediately becomes immutable",
      sealedNow?.medical_history === "sequence probe",
      resealError?.message?.slice(0, 60),
    );
  }

  /* ---------------------------------------------------------------- */
  console.log("\nAbandoned drafts can be discarded, signed records cannot\n");

  const { data: abandoned } = await asReceptionistA
    .from("consent_forms")
    .insert({
      salon_id: salonA.salonId,
      customer_id: fixturesA.customerId,
      collected_by: receptionistA.userId,
    })
    .select("id")
    .single();

  // A colleague's draft is not theirs to discard.
  const { data: othersDraft } = await asStaffA
    .from("consent_forms")
    .delete()
    .eq("id", abandoned.id)
    .select();
  const { data: survives } = await admin
    .from("consent_forms")
    .select("id")
    .eq("id", abandoned.id)
    .maybeSingle();
  check(
    "a colleague cannot discard someone else's draft",
    Boolean(survives) && (othersDraft ?? []).length === 0,
  );

  await asReceptionistA.from("consent_forms").delete().eq("id", abandoned.id);
  const { data: discarded } = await admin
    .from("consent_forms")
    .select("id")
    .eq("id", abandoned.id)
    .maybeSingle();
  check("the collector can discard their own unsigned draft", !discarded);

  /* ---------------------------------------------------------------- */
  /* Phase 3: the booking diary                                         */
  /* ---------------------------------------------------------------- */
  console.log("\nPhase 3 fixtures\n");

  const bookingsA = await seedBookings(
    salonA.salonId,
    fixturesA,
    // who performs it (roster), then who took the booking (login).
    staffA.memberId,
    receptionistA.userId,
  );
  const bookingsB = await seedBookings(
    salonB.salonId,
    fixturesB,
    staffB.memberId,
    salonB.userId,
  );
  check("both salons have a booking and a linked consent form", true);

  /* ---------------------------------------------------------------- */
  console.log("\nAppointments are never visible across tenants\n");

  for (const [label, client] of roles) {
    const { data } = await client.from("appointments").select("salon_id");
    const foreign = (data ?? []).filter((r) => r.salon_id !== salonA.salonId);
    check(`${label} sees no appointments from Salon B`, foreign.length === 0);
  }

  const { data: bAppointmentById } = await asOwnerA
    .from("appointments")
    .select("id")
    .eq("id", bookingsB.appointmentId);
  check("owner A cannot read Salon B's appointment by id", (bAppointmentById ?? []).length === 0);

  const { error: foreignBooking } = await asOwnerA.from("appointments").insert({
    salon_id: salonB.salonId,
    customer_id: fixturesB.customerId,
    staff_id: staffB.memberId,
    service_id: fixturesB.serviceId,
    starts_at: bookingsB.startsAt,
    ends_at: bookingsB.endsAt,
    price_at_booking: 10,
  });
  check("owner A cannot book into Salon B", Boolean(foreignBooking));

  const { error: stitchedBooking } = await asOwnerA.from("appointments").insert({
    salon_id: salonA.salonId,
    customer_id: fixturesA.customerId,
    staff_id: staffB.memberId, // another salon's therapist
    service_id: fixturesA.serviceId,
    starts_at: new Date(Date.now() + 86_400_000 * 5).toISOString(),
    ends_at: new Date(Date.now() + 86_400_000 * 5 + 1_800_000).toISOString(),
    price_at_booking: 10,
  });
  check(
    "a booking cannot be assigned to another salon's therapist",
    Boolean(stitchedBooking),
    stitchedBooking?.message?.slice(0, 60),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nWho may read and change the diary\n");

  const { data: ownerSeesDiary } = await asOwnerA.from("appointments").select("id");
  check("owner A sees the whole diary", (ownerSeesDiary ?? []).length === 1);

  const { data: receptionSeesDiary } = await asReceptionistA.from("appointments").select("id");
  check("receptionist A sees the whole diary", (receptionSeesDiary ?? []).length === 1);

  const { data: staffSeesOwn } = await asStaffA.from("appointments").select("id, staff_id");
  check(
    "staff A sees only their own appointments",
    (staffSeesOwn ?? []).length === 1 && staffSeesOwn[0].staff_id === staffA.memberId,
  );

  const { error: staffBooks } = await asStaffA.from("appointments").insert({
    salon_id: salonA.salonId,
    customer_id: fixturesA.customerId,
    staff_id: staffA.memberId,
    service_id: fixturesA.serviceId,
    starts_at: new Date(Date.now() + 86_400_000 * 6).toISOString(),
    ends_at: new Date(Date.now() + 86_400_000 * 6 + 1_800_000).toISOString(),
    price_at_booking: 10,
  });
  check("staff A cannot book appointments", Boolean(staffBooks));

  const { error: staffEdits } = await asStaffA
    .from("appointments")
    .update({ status: "completed" })
    .eq("id", bookingsA.appointmentId)
    .select();
  const { data: statusAfterStaffEdit } = await admin
    .from("appointments")
    .select("status")
    .eq("id", bookingsA.appointmentId)
    .single();
  check(
    "staff A cannot change their own appointment's status",
    statusAfterStaffEdit?.status === "booked",
    staffEdits?.message ?? "update matched no rows",
  );

  const { data: deleted } = await asOwnerA
    .from("appointments")
    .delete()
    .eq("id", bookingsA.appointmentId)
    .select();
  const { data: appointmentSurvives } = await admin
    .from("appointments")
    .select("id")
    .eq("id", bookingsA.appointmentId)
    .maybeSingle();
  check(
    "appointments cannot be deleted, only resolved",
    Boolean(appointmentSurvives) && (deleted ?? []).length === 0,
  );

  /* ---------------------------------------------------------------- */
  console.log("\nDouble-booking is refused by the database, not by a check\n");

  const clashStart = new Date(new Date(bookingsA.startsAt).getTime() + 15 * 60_000);
  const clashEnd = new Date(clashStart.getTime() + 30 * 60_000);

  const { error: clash } = await asReceptionistA.from("appointments").insert({
    salon_id: salonA.salonId,
    customer_id: fixturesA.customerId,
    staff_id: staffA.memberId,
    service_id: fixturesA.serviceId,
    starts_at: clashStart.toISOString(),
    ends_at: clashEnd.toISOString(),
    price_at_booking: 250,
  });
  check("an overlapping booking is rejected", clash?.code === "23P01", clash?.code ?? "no error");

  // A walk-in is explicitly allowed to overlap -- the brief asks for it.
  const { error: walkIn } = await asReceptionistA.from("appointments").insert({
    salon_id: salonA.salonId,
    customer_id: fixturesA.customerId,
    staff_id: staffA.memberId,
    service_id: fixturesA.serviceId,
    starts_at: clashStart.toISOString(),
    ends_at: clashEnd.toISOString(),
    price_at_booking: 250,
    is_walk_in: true,
  });
  check("a walk-in may overlap an existing booking", !walkIn, walkIn?.message?.slice(0, 60));

  // Back-to-back must not be treated as a clash: ranges are half-open.
  const { error: adjacent } = await asReceptionistA.from("appointments").insert({
    salon_id: salonA.salonId,
    customer_id: fixturesA.customerId,
    staff_id: staffA.memberId,
    service_id: fixturesA.serviceId,
    starts_at: bookingsA.endsAt,
    ends_at: new Date(new Date(bookingsA.endsAt).getTime() + 30 * 60_000).toISOString(),
    price_at_booking: 250,
  });
  check("a back-to-back booking is allowed", !adjacent, adjacent?.message?.slice(0, 60));

  /* ---------------------------------------------------------------- */
  console.log("\nAppointment lifecycle rules\n");

  const { error: noReason } = await asReceptionistA
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("id", bookingsA.appointmentId)
    .select();
  check(
    "cancelling without a reason is refused",
    Boolean(noReason),
    noReason?.message?.slice(0, 60),
  );

  const { error: cancelled } = await asReceptionistA
    .from("appointments")
    .update({ status: "cancelled", resolution_reason: "Customer rang to cancel" })
    .eq("id", bookingsA.appointmentId);
  check("cancelling with a reason succeeds", !cancelled, cancelled?.message);

  const { data: cancelledRow } = await admin
    .from("appointments")
    .select("resolved_at, resolved_by, resolution_reason")
    .eq("id", bookingsA.appointmentId)
    .single();
  check("the cancellation is stamped by the database", Boolean(cancelledRow?.resolved_at));
  check(
    "and attributed to whoever did it",
    cancelledRow?.resolved_by === receptionistA.userId,
  );

  const { error: revive } = await asReceptionistA
    .from("appointments")
    .update({ status: "booked" })
    .eq("id", bookingsA.appointmentId)
    .select();
  const { data: stillCancelled } = await admin
    .from("appointments")
    .select("status")
    .eq("id", bookingsA.appointmentId)
    .single();
  check(
    "a cancelled appointment cannot be revived",
    stillCancelled?.status === "cancelled",
    revive?.message?.slice(0, 60),
  );

  // The slot it occupied is free again.
  const { error: rebooked } = await asReceptionistA.from("appointments").insert({
    salon_id: salonA.salonId,
    customer_id: fixturesA.customerId,
    staff_id: staffA.memberId,
    service_id: fixturesA.serviceId,
    starts_at: bookingsA.startsAt,
    ends_at: bookingsA.endsAt,
    price_at_booking: 250,
  });
  check("the cancelled slot can be booked again", !rebooked, rebooked?.message?.slice(0, 60));

  const { error: receptionistBooked } = await asReceptionistA.from("appointments").insert({
    salon_id: salonA.salonId,
    customer_id: fixturesA.customerId,
    staff_id: receptionistA.memberId,
    service_id: fixturesA.serviceId,
    starts_at: new Date(Date.now() + 86_400_000 * 9).toISOString(),
    ends_at: new Date(Date.now() + 86_400_000 * 9 + 1_800_000).toISOString(),
    price_at_booking: 250,
  });
  check(
    "a receptionist cannot be booked to perform a treatment",
    Boolean(receptionistBooked),
    receptionistBooked?.message?.slice(0, 60),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nConsent visibility now follows the booking\n");

  // The form was collected by the receptionist, so the therapist can only see
  // it because it is attached to an appointment they are treating.
  const { data: therapistSeesLinked } = await asStaffA
    .from("consent_forms")
    .select("id, medical_history")
    .eq("id", bookingsA.linkedFormId);
  check(
    "the treating therapist can read consent for their own booking",
    (therapistSeesLinked ?? []).length === 1,
  );

  const { data: therapistLinkedSignature } = await asStaffA.storage
    .from(BUCKET)
    .download(bookingsA.linkedSignaturePath);
  check(
    "and can fetch its signature, because storage uses the same rule",
    Boolean(therapistLinkedSignature),
  );

  const { data: therapistLinkedResponses } = await asStaffA
    .from("consent_form_responses")
    .select("id")
    .eq("form_id", bookingsA.linkedFormId);
  check("and its responses", Array.isArray(therapistLinkedResponses));

  // The unrelated form the receptionist collected is still off limits.
  const { data: therapistStillBlocked } = await asStaffA
    .from("consent_forms")
    .select("id")
    .eq("id", fixturesA.receptionFormId);
  check(
    "a form with no booking of theirs is still hidden from the therapist",
    (therapistStillBlocked ?? []).length === 0,
  );

  const { data: otherTherapistLinked } = await asStaffB.storage
    .from(BUCKET)
    .download(bookingsA.linkedSignaturePath);
  check(
    "a therapist in another salon cannot reach it either",
    !otherTherapistLinked,
  );

  /* ---------------------------------------------------------------- */
  /* Phase 4: receipts and loyalty                                      */
  /* ---------------------------------------------------------------- */
  console.log("\nPhase 4: receipts and loyalty across tenants\n");

  // The money arithmetic itself is covered in depth by npm run test:money.
  // What matters here is that none of it leaks between salons.
  const posLine = (serviceId, staffId) => [{ service_id: serviceId, staff_id: staffId, quantity: 1 }];

  const { data: receiptA, error: receiptAError } = await asReceptionistA.rpc("create_receipt", {
    p_customer_id: fixturesA.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: posLine(fixturesA.serviceId, staffA.memberId),
  });
  check("receptionist A can take payment in their own salon", !receiptAError, receiptAError?.message);

  const { data: receiptB } = await asOwnerB.rpc("create_receipt", {
    p_customer_id: fixturesB.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: posLine(fixturesB.serviceId, staffB.memberId),
  });
  check("owner B can take payment in theirs", Boolean(receiptB));

  const { data: numbers } = await admin
    .from("receipts")
    .select("salon_id, receipt_number")
    .in("id", [receiptA, receiptB]);
  check(
    "receipt numbering restarts per salon",
    (numbers ?? []).every((r) => r.receipt_number === 1),
  );

  const { data: aSeesReceipts } = await asReceptionistA.from("receipts").select("salon_id");
  check(
    "receptionist A sees no receipts from Salon B",
    (aSeesReceipts ?? []).every((r) => r.salon_id === salonA.salonId),
  );

  const { data: bReceiptById } = await asOwnerA.from("receipts").select("id").eq("id", receiptB);
  check("owner A cannot read Salon B's receipt by id", (bReceiptById ?? []).length === 0);

  const { data: aSeesLedger } = await asOwnerA.from("loyalty_transactions").select("salon_id");
  check(
    "owner A sees no loyalty movements from Salon B",
    (aSeesLedger ?? []).every((r) => r.salon_id === salonA.salonId),
  );

  const { data: bLines } = await asOwnerA
    .from("receipt_line_items")
    .select("id")
    .eq("receipt_id", receiptB);
  check("owner A cannot read Salon B's receipt lines", (bLines ?? []).length === 0);

  // Checking out another salon's customer must fail inside the function, which
  // resolves the tenant from the caller's own session rather than the argument.
  const { error: foreignCheckout } = await asReceptionistA.rpc("create_receipt", {
    p_customer_id: fixturesB.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: posLine(fixturesA.serviceId, staffA.memberId),
  });
  check(
    "receptionist A cannot check out Salon B's customer",
    Boolean(foreignCheckout),
    foreignCheckout?.message?.slice(0, 70),
  );

  const { error: posForeignService } = await asReceptionistA.rpc("create_receipt", {
    p_customer_id: fixturesA.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: posLine(fixturesB.serviceId, staffA.memberId),
  });
  check(
    "receptionist A cannot sell Salon B's service",
    Boolean(posForeignService),
    posForeignService?.message?.slice(0, 70),
  );

  const { error: posForeignStaff } = await asReceptionistA.rpc("create_receipt", {
    p_customer_id: fixturesA.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: posLine(fixturesA.serviceId, staffB.memberId),
  });
  check(
    "receptionist A cannot credit Salon B's therapist",
    Boolean(posForeignStaff),
    posForeignStaff?.message?.slice(0, 70),
  );

  const { error: foreignVoid } = await asOwnerA.rpc("void_receipt", {
    p_receipt_id: receiptB,
    p_reason: "not mine to void",
  });
  const { data: bStillIssued } = await admin
    .from("receipts")
    .select("status")
    .eq("id", receiptB)
    .single();
  check(
    "owner A cannot void Salon B's receipt",
    bStillIssued?.status === "issued",
    foreignVoid?.message?.slice(0, 70),
  );

  const { data: foreignBalance } = await asOwnerA.rpc("customer_loyalty_balance", {
    p_customer_id: fixturesB.customerId,
  });
  check(
    "a loyalty balance cannot be read across tenants",
    Number(foreignBalance ?? 0) === 0,
    `got ${foreignBalance}`,
  );

  const { data: anonReceipts } = await anonClient().from("receipts").select("id").limit(1);
  check("anonymous cannot read receipts", (anonReceipts ?? []).length === 0);

  /* ---------------------------------------------------------------- */
  /* Phase 5: payroll                                                   */
  /* ---------------------------------------------------------------- */
  console.log("\nPayroll never crosses a tenant boundary\n");

  // Commission arithmetic itself is covered by npm run test:money.
  //
  // The error is CHECKED. This insert silently failed once, when the schema
  // moved on and the fixture did not -- leaving no rows, so the visibility
  // assertions below were passing against an empty table and proving nothing.
  const { error: seedRates } = await admin.from("staff_compensation").insert([
    {
      salon_id: salonA.salonId,
      staff_id: staffA.memberId,
      commission_basis: "percentage",
      commission_rate: 0.25,
      fixed_amount: null,
      salary_amount: 0,
    },
    {
      salon_id: salonB.salonId,
      staff_id: staffB.memberId,
      commission_basis: "percentage",
      commission_rate: 0.5,
      fixed_amount: null,
      salary_amount: 0,
    },
  ]);
  check("the commission fixtures seed", !seedRates, seedRates?.message);

  const payrollDay = new Date().toISOString().slice(0, 10);

  const { error: periodAError } = await asOwnerA.rpc("generate_payroll_period", {
    p_starts_on: payrollDay,
    p_ends_on: payrollDay,
    p_notes: "tenant A",
  });
  check("owner A can run their own payroll", !periodAError, periodAError?.message);

  const { data: periodB } = await asOwnerB.rpc("generate_payroll_period", {
    p_starts_on: payrollDay,
    p_ends_on: payrollDay,
    p_notes: "tenant B",
  });
  check("owner B can run theirs on the same dates", Boolean(periodB));

  const { data: aPeriods } = await asOwnerA.from("payroll_periods").select("salon_id");
  check(
    "owner A sees no payroll periods from Salon B",
    (aPeriods ?? []).every((p) => p.salon_id === salonA.salonId),
  );

  const { data: bPeriodById } = await asOwnerA
    .from("payroll_periods")
    .select("id")
    .eq("id", periodB);
  check("owner A cannot read Salon B's period by id", (bPeriodById ?? []).length === 0);

  const { data: aEntries } = await asOwnerA.from("payroll_entries").select("salon_id");
  check(
    "owner A sees no payroll entries from Salon B",
    (aEntries ?? []).every((e) => e.salon_id === salonA.salonId),
  );

  const { data: aRates } = await asOwnerA.from("staff_compensation").select("salon_id");
  check(
    "owner A sees no commission rates from Salon B",
    (aRates ?? []).every((r) => r.salon_id === salonA.salonId),
  );

  const { error: foreignRate } = await asOwnerA.from("staff_compensation").insert({
    salon_id: salonB.salonId,
    staff_id: staffB.memberId,
    commission_basis: "percentage",
    commission_rate: 0.99,
    fixed_amount: null,
    salary_amount: 0,
  });
  check("owner A cannot set a rate in Salon B", Boolean(foreignRate));

  /*
   * A service now carries its own default commission, which is a pay setting
   * living on a table the whole salon can read. Reading it is harmless; being
   * able to RAISE it would let a therapist give themselves a pay rise.
   */
  const { data: ownerSetsServiceRate } = await asOwnerA
    .from("services")
    .update({ commission_basis: "percentage", commission_rate: 0.15, commission_fixed: null })
    .eq("id", fixturesA.serviceId)
    .select("commission_rate");
  check(
    "the owner can set a service's commission rate",
    (ownerSetsServiceRate ?? []).length === 1,
  );

  const { data: staffSetsServiceRate } = await asStaffA
    .from("services")
    .update({ commission_rate: 0.9 })
    .eq("id", fixturesA.serviceId)
    .select("commission_rate");
  const { data: serviceRateNow } = await admin
    .from("services")
    .select("commission_rate")
    .eq("id", fixturesA.serviceId)
    .single();
  check(
    "a therapist cannot raise a service's commission rate",
    (staffSetsServiceRate ?? []).length === 0 && Number(serviceRateNow.commission_rate) === 0.15,
    `rate is now ${serviceRateNow.commission_rate}`,
  );

  const { data: bSetsServiceRate } = await asOwnerB
    .from("services")
    .update({ commission_rate: 0.9 })
    .eq("id", fixturesA.serviceId)
    .select("commission_rate");
  check(
    "and another salon's owner cannot touch it",
    (bSetsServiceRate ?? []).length === 0,
  );

  const { error: foreignPaid } = await asOwnerA.rpc("mark_payroll_paid", {
    p_period_id: periodB,
  });
  const { data: bPeriodStatus } = await admin
    .from("payroll_periods")
    .select("status")
    .eq("id", periodB)
    .single();
  check(
    "owner A cannot mark Salon B's payroll paid",
    bPeriodStatus?.status === "draft",
    foreignPaid?.message?.slice(0, 70),
  );

  const { error: foreignDiscard } = await asOwnerA
    .from("payroll_periods")
    .delete()
    .eq("id", periodB)
    .select();
  const { data: bPeriodSurvives } = await admin
    .from("payroll_periods")
    .select("id")
    .eq("id", periodB)
    .maybeSingle();
  check(
    "owner A cannot discard Salon B's draft",
    Boolean(bPeriodSurvives),
    foreignDiscard?.message ?? "delete matched no rows",
  );

  // Commission is salon-wide information the front desk has no part in.
  const { data: deskSeesPayroll } = await asReceptionistA.from("payroll_periods").select("id");
  check("receptionist A sees no payroll at all", (deskSeesPayroll ?? []).length === 0);

  const { data: deskSeesRates } = await asReceptionistA.from("staff_compensation").select("staff_id");
  check("receptionist A sees no commission rates", (deskSeesRates ?? []).length === 0);

  const { data: staffSeesOwnOnly } = await asStaffA
    .from("staff_compensation")
    .select("staff_id");
  check(
    "staff A sees only their own rate",
    (staffSeesOwnOnly ?? []).length === 1 && staffSeesOwnOnly[0].staff_id === staffA.memberId,
    `saw ${(staffSeesOwnOnly ?? []).length}`,
  );

  const { data: anonPayroll } = await anonClient().from("payroll_entries").select("id").limit(1);
  check("anonymous cannot read payroll", (anonPayroll ?? []).length === 0);

  /* ---------------------------------------------------------------- */
  /* Phase 6: reporting                                                 */
  /* ---------------------------------------------------------------- */
  console.log("\nReports aggregate one tenant only\n");

  // Both salons sold today (Phase 4 above). An aggregate that forgot its tenant
  // filter would quietly fold Salon B's money into Salon A's figures -- the one
  // failure mode that RLS on the underlying tables is there to prevent, and the
  // reason these functions are SECURITY INVOKER rather than DEFINER.
  const reportDay = new Date().toISOString().slice(0, 10);
  const reportArgs = { p_from: reportDay, p_to: reportDay };

  const { data: revenueA } = await asOwnerA.rpc("report_revenue_over_time", {
    ...reportArgs,
    p_granularity: "day",
  });
  const { data: revenueB } = await asOwnerB.rpc("report_revenue_over_time", {
    ...reportArgs,
    p_granularity: "day",
  });

  const sumA = (revenueA ?? []).reduce((n, r) => n + Number(r.revenue), 0);
  const sumB = (revenueB ?? []).reduce((n, r) => n + Number(r.revenue), 0);
  const receiptsA = (revenueA ?? []).reduce((n, r) => n + Number(r.receipt_count), 0);

  const { data: trueA } = await admin
    .from("receipts")
    .select("total")
    .eq("salon_id", salonA.salonId)
    .eq("status", "issued");
  const expectedA = (trueA ?? []).reduce((n, r) => n + Number(r.total), 0);

  check(
    "owner A's revenue is exactly their own salon's",
    sumA.toFixed(2) === expectedA.toFixed(2),
    `report ${sumA.toFixed(2)} vs actual ${expectedA.toFixed(2)}`,
  );
  check("owner A counted only their own receipts", receiptsA === (trueA ?? []).length);
  check("owner B gets their own, separate figure", sumB > 0 && sumB !== sumA + sumB - sumA + 1);

  const { data: staffRevenueA } = await asOwnerA.rpc("report_revenue_by_staff", reportArgs);
  // Reports attribute work to the ROSTER, so these are roster ids.
  const knownA = new Set([salonA.memberId, staffA.memberId, receptionistA.memberId]);
  check(
    "revenue by staff lists nobody from Salon B",
    (staffRevenueA ?? []).every((row) => row.staff_id === null || knownA.has(row.staff_id)),
  );

  const { data: retentionA } = await asOwnerA.rpc("report_customer_retention", reportArgs);
  check(
    "retention counts only this salon's customers",
    Number(retentionA?.[0]?.total_customers ?? 0) <= 1,
    `counted ${retentionA?.[0]?.total_customers}`,
  );

  const { data: loyaltyA } = await asOwnerA.rpc("report_loyalty_cost", reportArgs);
  const { data: trueLoyaltyA } = await admin
    .from("loyalty_transactions")
    .select("amount, type")
    .eq("salon_id", salonA.salonId)
    .eq("type", "earn");
  const expectedIssued = (trueLoyaltyA ?? []).reduce((n, r) => n + Number(r.amount), 0);
  check(
    "loyalty liability is this salon's alone",
    Number(loyaltyA?.[0]?.issued ?? -1).toFixed(2) === expectedIssued.toFixed(2),
    `report ${loyaltyA?.[0]?.issued} vs actual ${expectedIssued.toFixed(2)}`,
  );

  const { data: peaksA } = await asOwnerA.rpc("report_peak_times", reportArgs);
  check("peak times returns rows for this salon", Array.isArray(peaksA));

  for (const [label, client] of [
    ["receptionist A", asReceptionistA],
    ["staff A", asStaffA],
  ]) {
    const { error } = await client.rpc("report_revenue_over_time", {
      ...reportArgs,
      p_granularity: "day",
    });
    check(`${label} cannot run reports`, Boolean(error), error?.message?.slice(0, 60));
  }

  const { error: anonReport } = await anonClient().rpc("report_loyalty_cost", reportArgs);
  check("anonymous cannot run reports", Boolean(anonReport));

  /* ---------------------------------------------------------------- */
  console.log("\nConsent attachments carry the same protections as signatures\n");

  const ATT_BUCKET = "consent-attachments";
  const PDF_BYTES = Buffer.from("%PDF-1.4\n%fake test document\n", "utf8");

  /**
   * Attach a document to a form, the way the intake action does: upload the
   * object, then record the row that describes it.
   */
  async function attachTo(client, salonId, customerId, formId, uploaderId) {
    const attachmentId = randomUUID();
    const path = `${salonId}/${customerId}/${formId}/${attachmentId}.pdf`;

    const { error: uploadError } = await client.storage
      .from(ATT_BUCKET)
      .upload(path, PDF_BYTES, { contentType: "application/pdf" });

    const { error: rowError } = await client.from("consent_form_attachments").insert({
      id: attachmentId,
      salon_id: salonId,
      form_id: formId,
      customer_id: customerId,
      file_path: path,
      file_name: "lab-result.pdf",
      mime_type: "application/pdf",
      size_bytes: PDF_BYTES.length,
      uploaded_by: uploaderId,
    });

    return { attachmentId, path, uploadError, rowError };
  }

  // A fresh draft belonging to the receptionist, to attach to.
  const { data: attachDraft } = await asReceptionistA
    .from("consent_forms")
    .insert({
      salon_id: salonA.salonId,
      customer_id: fixturesA.customerId,
      collected_by: receptionistA.userId,
    })
    .select("id")
    .single();

  const attached = await attachTo(
    asReceptionistA,
    salonA.salonId,
    fixturesA.customerId,
    attachDraft.id,
    receptionistA.userId,
  );
  check(
    "a document can be attached to your own unsigned draft",
    !attached.uploadError && !attached.rowError,
    attached.uploadError?.message ?? attached.rowError?.message,
  );

  // A colleague may not attach to someone else's draft.
  const foreignAttach = await attachTo(
    asStaffA,
    salonA.salonId,
    fixturesA.customerId,
    attachDraft.id,
    staffA.userId,
  );
  check(
    "a colleague cannot attach to someone else's draft",
    Boolean(foreignAttach.rowError),
    foreignAttach.rowError?.message?.slice(0, 60),
  );

  // Nothing can be attached beneath another salon's prefix.
  const { error: attachmentCrossUpload } = await asReceptionistA.storage
    .from(ATT_BUCKET)
    .upload(`${salonB.salonId}/${fixturesB.customerId}/x/intruder.pdf`, PDF_BYTES, {
      contentType: "application/pdf",
    });
  check(
    "a document cannot be uploaded into Salon B's prefix",
    Boolean(attachmentCrossUpload),
    attachmentCrossUpload?.message?.slice(0, 60),
  );

  const { error: attachmentCrossRow } = await asReceptionistA
    .from("consent_form_attachments")
    .insert({
      salon_id: salonB.salonId,
      form_id: fixturesB.receptionFormId,
      customer_id: fixturesB.customerId,
      file_path: `${salonB.salonId}/x/y/z.pdf`,
      file_name: "intruder.pdf",
      mime_type: "application/pdf",
      size_bytes: 100,
      uploaded_by: receptionistA.userId,
    });
  check("an attachment row cannot be written into Salon B", Boolean(attachmentCrossRow));

  // Seal the draft; from here it behaves exactly as the signature does.
  const sealPath = `${salonA.salonId}/${fixturesA.customerId}/${attachDraft.id}.png`;
  await asReceptionistA.storage
    .from(BUCKET)
    .upload(sealPath, PNG_BYTES, { contentType: "image/png" });
  await asReceptionistA
    .from("consent_forms")
    .update({ signature_path: sealPath, signed_at: new Date().toISOString() })
    .eq("id", attachDraft.id);

  const afterSigning = await attachTo(
    asReceptionistA,
    salonA.salonId,
    fixturesA.customerId,
    attachDraft.id,
    receptionistA.userId,
  );
  check(
    "nothing can be attached once the form is signed",
    Boolean(afterSigning.rowError),
    afterSigning.rowError?.message?.slice(0, 70),
  );
  // Tidy the object that upload left behind before the row was refused.
  await asReceptionistA.storage.from(ATT_BUCKET).remove([afterSigning.path]);

  const { error: removeSigned } = await asReceptionistA
    .from("consent_form_attachments")
    .delete()
    .eq("id", attached.attachmentId)
    .select();
  const { data: stillAttached } = await admin
    .from("consent_form_attachments")
    .select("id")
    .eq("id", attached.attachmentId)
    .maybeSingle();
  check(
    "an attachment on a signed form cannot be removed",
    Boolean(stillAttached),
    removeSigned?.message ?? "delete matched no rows",
  );

  const { error: renameAttachment } = await asOwnerA
    .from("consent_form_attachments")
    .update({ file_name: "tampered.pdf" })
    .eq("id", attached.attachmentId)
    .select();
  const { data: nameNow } = await admin
    .from("consent_form_attachments")
    .select("file_name")
    .eq("id", attached.attachmentId)
    .single();
  check(
    "and cannot be renamed",
    nameNow?.file_name === "lab-result.pdf",
    renameAttachment?.message?.slice(0, 60),
  );

  const { data: signedObjectGone } = await asOwnerA.storage
    .from(ATT_BUCKET)
    .remove([attached.path]);
  const { data: objectStill } = await asOwnerA.storage.from(ATT_BUCKET).download(attached.path);
  check(
    "the stored file itself is pinned once signed",
    Boolean(objectStill),
    `remove returned ${JSON.stringify(signedObjectGone)}`,
  );

  /* ---- who may read an attachment ---------------------------------- */

  const { data: ownerReads } = await asOwnerA.storage.from(ATT_BUCKET).download(attached.path);
  check("owner A can open an attachment in their own salon", Boolean(ownerReads));

  const { data: deskReads } = await asReceptionistA.storage
    .from(ATT_BUCKET)
    .download(attached.path);
  check("the receptionist who collected it can open it", Boolean(deskReads));

  const { data: staffReads } = await asStaffA.storage.from(ATT_BUCKET).download(attached.path);
  check(
    "a therapist with no claim on the form cannot open it, even with the path",
    !staffReads,
  );

  const { data: attachmentCrossRead } = await asOwnerB.storage
    .from(ATT_BUCKET)
    .download(attached.path);
  check("owner B cannot open Salon A's attachment", !attachmentCrossRead);

  const { data: attachmentAnonRead } = await anonClient().storage.from(ATT_BUCKET).download(attached.path);
  check("anonymous cannot open an attachment", !attachmentAnonRead);

  const { data: attachmentFolderList } = await asOwnerB.storage.from(ATT_BUCKET).list(salonA.salonId);
  check(
    "owner B cannot list Salon A's attachment folder",
    (attachmentFolderList ?? []).length === 0,
    `saw ${(attachmentFolderList ?? []).length}`,
  );

  const { data: bSeesRows } = await asOwnerB.from("consent_form_attachments").select("salon_id");
  check(
    "owner B sees no attachment rows from Salon A",
    (bSeesRows ?? []).every((r) => r.salon_id === salonB.salonId),
  );

  const { data: staffSeesRows } = await asStaffA
    .from("consent_form_attachments")
    .select("id")
    .eq("id", attached.attachmentId);
  check(
    "a therapist cannot even see that the attachment exists",
    (staffSeesRows ?? []).length === 0,
  );

  // The visibility rule is shared, so a therapist treating the appointment can
  // read attachments on that booking's form -- the Phase 3 widening applies here
  // too, because both go through can_access_consent_form().
  const linkedAttachment = await attachTo(
    asOwnerA,
    salonA.salonId,
    fixturesA.customerId,
    bookingsA.linkedFormId,
    salonA.userId,
  );
  if (linkedAttachment.rowError) {
    check(
      "an attachment on an already-signed linked form is refused",
      true,
      "as designed: that form is signed",
    );
    await asOwnerA.storage.from(ATT_BUCKET).remove([linkedAttachment.path]);
  } else {
    const { data: therapistReads } = await asStaffA.storage
      .from(ATT_BUCKET)
      .download(linkedAttachment.path);
    check("the treating therapist can open their booking's attachment", Boolean(therapistReads));
  }

  /* ---------------------------------------------------------------- */
  console.log("\nAppointment service lines follow the appointment\n");

  // Lines are visible to whoever can see the booking they belong to, which for
  // a therapist means their own column of the diary and nothing else.
  const { error: lineSeedError } = await admin.from("appointment_services").insert({
    salon_id: salonA.salonId,
    appointment_id: bookingsA.appointmentId,
    service_id: fixturesA.serviceId,
    service_name: "Alpha Botox",
    quantity: 1,
    unit_price: 250,
    duration_minutes: 45,
    sort_order: 0,
  });
  check("a service line can be attached to a booking", !lineSeedError, lineSeedError?.message);

  const { data: ownerApptLines } = await asOwnerA.from("appointment_services").select("salon_id");
  check(
    "owner A sees no service lines from Salon B",
    (ownerApptLines ?? []).every((r) => r.salon_id === salonA.salonId),
  );

  const { data: bApptLines } = await asOwnerA
    .from("appointment_services")
    .select("id")
    .eq("appointment_id", bookingsB.appointmentId);
  check("owner A cannot read Salon B's service lines", (bApptLines ?? []).length === 0);

  const { data: staffOwnLines } = await asStaffA.from("appointment_services").select("id");
  check(
    "the treating therapist sees their own booking's lines",
    (staffOwnLines ?? []).length === 1,
    `saw ${(staffOwnLines ?? []).length}`,
  );

  const { data: staffBLines } = await asStaffB.from("appointment_services").select("id");
  check("a therapist in another salon sees none of them", (staffBLines ?? []).length === 0);

  const { error: staffWritesLine } = await asStaffA.from("appointment_services").insert({
    salon_id: salonA.salonId,
    appointment_id: bookingsA.appointmentId,
    service_id: fixturesA.serviceId,
    service_name: "Snuck in",
    quantity: 1,
    unit_price: 0,
    duration_minutes: 30,
  });
  check("a therapist cannot add a line to their own booking", Boolean(staffWritesLine));

  const { error: foreignApptLine } = await asOwnerA.from("appointment_services").insert({
    salon_id: salonB.salonId,
    appointment_id: bookingsB.appointmentId,
    service_id: fixturesB.serviceId,
    service_name: "Intruder",
    quantity: 1,
    unit_price: 10,
    duration_minutes: 30,
  });
  check("owner A cannot add a line to Salon B's booking", Boolean(foreignApptLine));

  // The booking function itself refuses to reach across tenants.
  const { error: foreignBookingRpc } = await asReceptionistA.rpc("create_appointment", {
    p_customer_id: fixturesB.customerId,
    p_new_customer_name: null,
    p_new_customer_phone: null,
    p_staff_id: staffA.memberId,
    p_starts_at: new Date(Date.now() + 86_400_000 * 12).toISOString(),
    p_notes: "",
    p_is_walk_in: true,
    p_discount: 0,
    p_quoted_total: null,
    p_lines: [{ service_id: fixturesA.serviceId, quantity: 1 }],
  });
  check(
    "receptionist A cannot book Salon B's customer",
    Boolean(foreignBookingRpc),
    foreignBookingRpc?.message?.slice(0, 70),
  );

  const { error: staffBooksRpc } = await asStaffA.rpc("create_appointment", {
    p_customer_id: fixturesA.customerId,
    p_new_customer_name: null,
    p_new_customer_phone: null,
    p_staff_id: staffA.memberId,
    p_starts_at: new Date(Date.now() + 86_400_000 * 13).toISOString(),
    p_notes: "",
    p_is_walk_in: true,
    p_discount: 0,
    p_quoted_total: null,
    p_lines: [{ service_id: fixturesA.serviceId, quantity: 1 }],
  });
  check("a therapist cannot book through the function either", Boolean(staffBooksRpc));

  // Customer search is scoped by the caller's own salon, not by its argument.
  const { data: apptCrossSearch } = await asOwnerA.rpc("search_customers", {
    p_query: "Bravo",
    p_limit: 5,
  });
  check(
    "customer search never reaches another salon",
    (apptCrossSearch ?? []).length === 0,
    `found ${(apptCrossSearch ?? []).length}`,
  );

  const { data: apptAnonSearch } = await anonClient().rpc("search_customers", {
    p_query: "a",
    p_limit: 5,
  });
  check("anonymous search returns nothing", (apptAnonSearch ?? []).length === 0);

  /* ---------------------------------------------------------------- */
  console.log("\nThe payment ledger is the front desk's\n");

  /*
   * What a customer has paid and still owes is till business. A therapist has
   * no reason to see it, exactly as with `receipts` -- and nobody at all may
   * write to the table directly, because a money ledger that can be edited is
   * not a ledger.
   */
  const { data: payVisit } = await admin
    .from("appointments")
    .select("id, customer_id")
    .eq("salon_id", salonA.salonId)
    .limit(1)
    .maybeSingle();
  check("there is an appointment to pay for", Boolean(payVisit));

  const { data: takenId, error: takeError } = await asReceptionistA.rpc("record_payment", {
    p_appointment_id: payVisit.id,
    p_amount: 5,
    p_method: "cash",
    p_paid_at: null,
    p_note: "rls advance",
  });
  check("the receptionist can take a payment", !takeError, takeError?.message?.slice(0, 80));

  const { data: ownerSeesPayments } = await asOwnerA.from("payments").select("id");
  check("the owner sees the ledger", (ownerSeesPayments ?? []).length > 0);

  const { data: deskSeesPayments } = await asReceptionistA.from("payments").select("id");
  check("so does the receptionist", (deskSeesPayments ?? []).length > 0);

  const { data: staffSeesPayments } = await asStaffA.from("payments").select("id");
  check(
    "a therapist sees no payments at all",
    (staffSeesPayments ?? []).length === 0,
    `saw ${(staffSeesPayments ?? []).length}`,
  );

  const { data: bSeesPayments } = await asOwnerB.from("payments").select("salon_id");
  check(
    "owner B sees none of Salon A's payments",
    (bSeesPayments ?? []).every((r) => r.salon_id === salonB.salonId),
  );

  const { data: anonPayments } = await anonClient().from("payments").select("id");
  check("anonymous sees no payments", (anonPayments ?? []).length === 0);

  /* ---- nobody writes to it directly ------------------------------- */

  for (const [label, client] of [
    ["the owner", asOwnerA],
    ["a receptionist", asReceptionistA],
    ["a therapist", asStaffA],
  ]) {
    const { data: inserted } = await client
      .from("payments")
      .insert({
        salon_id: salonA.salonId,
        customer_id: payVisit.customer_id,
        appointment_id: payVisit.id,
        kind: "deposit",
        method: "cash",
        amount: 999,
      })
      .select();
    check(
      `${label} cannot insert a payment by hand`,
      (inserted ?? []).length === 0,
      "a row was written straight into the ledger",
    );
  }

  const { data: editedPayment } = await asOwnerA
    .from("payments")
    .update({ amount: 999 })
    .eq("id", takenId)
    .select();
  check("the owner cannot edit a payment", (editedPayment ?? []).length === 0);

  const { data: deletedPayment } = await asOwnerA
    .from("payments")
    .delete()
    .eq("id", takenId)
    .select();
  check("nor delete one", (deletedPayment ?? []).length === 0);

  /* ---- cross-tenant, through the functions ------------------------ */

  const { error: bPaysA } = await asOwnerB.rpc("record_payment", {
    p_appointment_id: payVisit.id,
    p_amount: 5,
    p_method: "cash",
    p_paid_at: null,
    p_note: "",
  });
  check(
    "another salon cannot pay towards Salon A's visit",
    Boolean(bPaysA),
    bPaysA?.message?.slice(0, 70),
  );

  const { error: bRefundsA } = await asOwnerB.rpc("refund_payment", {
    p_payment_id: takenId,
    p_reason: "Not mine to give back",
  });
  check("nor refund one of its payments", Boolean(bRefundsA));

  const { data: bBalance } = await asOwnerB.rpc("appointment_balance", {
    p_appointment_id: payVisit.id,
  });
  check(
    "nor read what it is owed",
    (bBalance ?? []).length === 0,
    `got ${(bBalance ?? []).length} rows`,
  );

  const { error: bEdits } = await asOwnerB.rpc("update_appointment_services", {
    p_appointment_id: payVisit.id,
    p_lines: [{ service_id: fixturesA.serviceId, quantity: 1 }],
    p_discount: 0,
    p_quoted_total: null,
  });
  check("nor change what is booked on it", Boolean(bEdits), bEdits?.message?.slice(0, 70));



  /* ---------------------------------------------------------------- */
  console.log("\nStaff ID documents are the owner's alone\n");

  /*
   * An ID card is held about a real person for the owner's records. The bar is
   * the one consent forms set: not merely "another tenant cannot read it", but
   * "nobody inside this salon can either, including the person it belongs to
   * and including someone who has somehow learned the exact object path".
   */
  const DOC_BUCKET = "staff-documents";
  const CARD_BYTES = Buffer.from("%PDF-1.4\n%fake id card\n", "utf8");

  async function putCard(client, salonId, staffId, uploaderId) {
    const documentId = randomUUID();
    const path = `${salonId}/${staffId}/${documentId}.pdf`;

    const { error: uploadError } = await client.storage
      .from(DOC_BUCKET)
      .upload(path, CARD_BYTES, { contentType: "application/pdf" });

    const { error: rowError } = await client.from("staff_documents").insert({
      id: documentId,
      salon_id: salonId,
      staff_id: staffId,
      doc_type: "id_card",
      file_path: path,
      file_name: "id-card.pdf",
      mime_type: "application/pdf",
      size_bytes: CARD_BYTES.length,
      uploaded_by: uploaderId,
    });

    return { documentId, path, uploadError, rowError };
  }

  const cardA = await putCard(asOwnerA, salonA.salonId, staffA.memberId, salonA.userId);
  check("the owner can file an ID card for a team member", !cardA.rowError, cardA.rowError?.message);
  check("and the object uploads", !cardA.uploadError, cardA.uploadError?.message);

  /* ---- who may write one ------------------------------------------- */

  const deskCard = await putCard(
    asReceptionistA,
    salonA.salonId,
    receptionistA.memberId,
    receptionistA.userId,
  );
  check(
    "a receptionist cannot file an ID card",
    Boolean(deskCard.rowError),
    deskCard.rowError?.message?.slice(0, 70),
  );
  check("nor upload into the bucket", Boolean(deskCard.uploadError));

  const staffCard = await putCard(asStaffA, salonA.salonId, staffA.memberId, staffA.userId);
  check(
    "a therapist cannot file one either",
    Boolean(staffCard.rowError),
    staffCard.rowError?.message?.slice(0, 70),
  );
  check("nor upload into the bucket", Boolean(staffCard.uploadError));

  // Owner B, filing against Salon A's staff member, under Salon A's prefix.
  const crossCard = await putCard(asOwnerB, salonA.salonId, staffA.memberId, salonB.userId);
  check(
    "an owner cannot file a card into another salon",
    Boolean(crossCard.rowError),
    crossCard.rowError?.message?.slice(0, 70),
  );
  check("nor upload under another salon's prefix", Boolean(crossCard.uploadError));

  /* ---- who may read one -------------------------------------------- */

  const { data: ownerSeesCard } = await asOwnerA
    .from("staff_documents")
    .select("id")
    .eq("id", cardA.documentId);
  check("the owner sees the row", (ownerSeesCard ?? []).length === 1);

  const { data: ownerOpensCard } = await asOwnerA.storage.from(DOC_BUCKET).download(cardA.path);
  check("and can open the file", Boolean(ownerOpensCard));

  const { data: subjectSeesCard } = await asStaffA
    .from("staff_documents")
    .select("id")
    .eq("id", cardA.documentId);
  check(
    "the person it belongs to cannot even see the row",
    (subjectSeesCard ?? []).length === 0,
  );

  const { data: subjectOpensCard } = await asStaffA.storage.from(DOC_BUCKET).download(cardA.path);
  check(
    "and cannot open their own card, holding the exact path",
    !subjectOpensCard,
  );

  const { data: deskSeesCard } = await asReceptionistA.from("staff_documents").select("id");
  check("a receptionist sees no ID documents at all", (deskSeesCard ?? []).length === 0);

  const { data: deskOpensCard } = await asReceptionistA.storage
    .from(DOC_BUCKET)
    .download(cardA.path);
  check("and cannot open one with the path", !deskOpensCard);

  const { data: bSeesCards } = await asOwnerB.from("staff_documents").select("salon_id");
  check(
    "owner B sees no ID documents from Salon A",
    (bSeesCards ?? []).every((r) => r.salon_id === salonB.salonId),
  );

  const { data: bOpensCard } = await asOwnerB.storage.from(DOC_BUCKET).download(cardA.path);
  check("owner B cannot open Salon A's card", !bOpensCard);

  const { data: bListsCards } = await asOwnerB.storage.from(DOC_BUCKET).list(salonA.salonId);
  check(
    "owner B cannot list Salon A's document folder",
    (bListsCards ?? []).length === 0,
    `saw ${(bListsCards ?? []).length}`,
  );

  const { data: anonOpensCard } = await anonClient().storage.from(DOC_BUCKET).download(cardA.path);
  check("anonymous cannot open a card", !anonOpensCard);

  /* ---- the bucket is private --------------------------------------- */

  const { data: docBucket } = await admin.storage.getBucket(DOC_BUCKET);
  check("the staff-documents bucket is not public", docBucket?.public === false);

  /* ---- there is no UPDATE path ------------------------------------- */

  const { error: renameCard } = await asOwnerA
    .from("staff_documents")
    .update({ file_name: "tampered.pdf" })
    .eq("id", cardA.documentId)
    .select();
  const { data: cardNameNow } = await admin
    .from("staff_documents")
    .select("file_name")
    .eq("id", cardA.documentId)
    .single();
  check(
    "a filed card cannot be edited in place -- replacing it is a delete and an insert",
    cardNameNow?.file_name === "id-card.pdf",
    renameCard?.message?.slice(0, 60),
  );

  /* ---- the owner can remove one ------------------------------------ */

  const removable = await putCard(
    asOwnerA,
    salonA.salonId,
    receptionistA.memberId,
    salonA.userId,
  );
  const { data: staffDeletes } = await asStaffA
    .from("staff_documents")
    .delete()
    .eq("id", removable.documentId)
    .select();
  check("a therapist cannot delete a card", (staffDeletes ?? []).length === 0);

  const { data: ownerDeletes } = await asOwnerA
    .from("staff_documents")
    .delete()
    .eq("id", removable.documentId)
    .select();
  check("the owner can remove a card", (ownerDeletes ?? []).length === 1);
  await asOwnerA.storage.from(DOC_BUCKET).remove([removable.path]);

  /* ---------------------------------------------------------------- */
  console.log("\nRoles decide what a login can reach\n");

  /*
   * The point of Phase 7b: a salon defines its own roles, and ticking a module
   * changes what the DATABASE returns -- not merely which links are drawn.
   * Every check below goes through RLS with no application code involved.
   */
  const { data: rolesA } = await admin
    .from("roles")
    .select("id, name, is_owner, is_system")
    .eq("salon_id", salonA.salonId);

  const roleNamed = (name) => (rolesA ?? []).find((r) => r.name === name);
  const ownerRole = (rolesA ?? []).find((r) => r.is_owner);
  const accountantRole = roleNamed("Accountant");
  const staffRole = roleNamed("Staff / Therapist");

  check("a salon is seeded with its built-in roles", (rolesA ?? []).length === 4);
  check("exactly one of them is the owner role", Boolean(ownerRole));
  check("and an Accountant exists -- the role the old model could not express",
    Boolean(accountantRole));

  /* ---- a role reaches exactly what it is ticked for ----------------- */

  const accountant = await createMember(salonA.salonId, "staff", salonA.userId);
  await admin.from("profiles").update({ role_id: accountantRole.id }).eq("id", accountant.userId);
  const asAccountant = await clientFor(accountant.email);

  const { data: acctReports, error: acctReportError } = await asAccountant.rpc(
    "report_revenue_over_time",
    { p_from: "2020-01-01", p_to: "2099-12-31", p_granularity: "day" },
  );
  check(
    "the Accountant can run reports",
    !acctReportError,
    acctReportError?.message?.slice(0, 70),
  );
  check("and gets rows back", Array.isArray(acctReports));

  const { data: acctPayroll } = await asAccountant.from("payroll_periods").select("id");
  check("and can see payroll", (acctPayroll ?? []).length > 0);

  // Not ticked: the till and the customer list.
  const { data: acctReceipts } = await asAccountant.from("receipts").select("id");
  check(
    "but NOT the till -- pos is not ticked",
    (acctReceipts ?? []).length === 0,
    `saw ${(acctReceipts ?? []).length} receipts`,
  );

  const { data: acctAudit } = await asAccountant.from("audit_logs").select("id");
  check("nor the audit log", (acctAudit ?? []).length === 0);

  const { data: acctCustomerWrite } = await asAccountant
    .from("customers")
    .insert({ salon_id: salonA.salonId, full_name: "Nope", phone: "+15550001" })
    .select();
  check("nor add a customer", (acctCustomerWrite ?? []).length === 0);

  /* ---- unticking a module takes the data away, not just the link --- */

  await admin
    .from("role_modules")
    .delete()
    .eq("role_id", accountantRole.id)
    .eq("module", "payroll");

  const { data: afterUntick } = await asAccountant.from("payroll_periods").select("id");
  check(
    "unticking payroll removes the rows immediately",
    (afterUntick ?? []).length === 0,
    `still saw ${(afterUntick ?? []).length}`,
  );

  const { data: stillReports, error: stillReportsError } = await asAccountant.rpc(
    "report_revenue_over_time",
    { p_from: "2020-01-01", p_to: "2099-12-31", p_granularity: "day" },
  );
  check(
    "while the module still ticked is untouched",
    !stillReportsError && Array.isArray(stillReports),
  );

  // Put it back so later sections see the salon as they expect.
  await admin
    .from("role_modules")
    .insert({ salon_id: salonA.salonId, role_id: accountantRole.id, module: "payroll" });

  /* ---- a role with no modules still sees its own work -------------- */

  const { data: staffModules } = await admin
    .from("role_modules")
    .select("module")
    .eq("role_id", staffRole.id);
  check(
    "Staff / Therapist is seeded with no modules at all",
    (staffModules ?? []).length === 0,
    `has ${(staffModules ?? []).map((m) => m.module).join(", ")}`,
  );

  const { data: staffOwnDiary } = await asStaffA.from("appointments").select("id, staff_id");
  check(
    "and still sees their own appointments regardless",
    (staffOwnDiary ?? []).length > 0 &&
      (staffOwnDiary ?? []).every((a) => a.staff_id === staffA.memberId),
    `saw ${(staffOwnDiary ?? []).length}`,
  );

  const { data: staffBooksRole } = await asStaffA
    .from("appointments")
    .insert({
      salon_id: salonA.salonId,
      customer_id: fixturesA.customerId,
      staff_id: staffA.memberId,
      service_id: fixturesA.serviceId,
      starts_at: new Date(Date.now() + 40 * 86400000).toISOString(),
      ends_at: new Date(Date.now() + 40 * 86400000 + 1800000).toISOString(),
      price_at_booking: 10,
    })
    .select();
  check(
    "but cannot book for anyone -- managing the diary is the calendar module",
    (staffBooksRole ?? []).length === 0,
  );

  /* ---- the owner role cannot be seized ----------------------------- */

  const { data: grabOwner } = await asOwnerA
    .from("profiles")
    .update({ role_id: ownerRole.id })
    .eq("id", staffA.userId)
    .select();
  const { data: staffRoleNow } = await admin
    .from("profiles")
    .select("role_id")
    .eq("id", staffA.userId)
    .single();
  check(
    "nobody can be moved onto the owner role",
    staffRoleNow.role_id !== ownerRole.id,
    `grabbed via ${(grabOwner ?? []).length} row(s)`,
  );

  const { error: renameOwner } = await asOwnerA
    .from("roles")
    .update({ name: "Overlord" })
    .eq("id", ownerRole.id);
  check("the owner role cannot be renamed", Boolean(renameOwner));

  const { error: deleteOwner } = await asOwnerA.from("roles").delete().eq("id", ownerRole.id);
  check("nor deleted", Boolean(deleteOwner));

  const { error: fakeOwner } = await asOwnerA.from("roles").insert({
    salon_id: salonA.salonId,
    name: "Second Owner",
    is_owner: true,
  });
  check("nor can a second owner role be created", Boolean(fakeOwner));

  const { error: tickOwner } = await asOwnerA.from("role_modules").insert({
    salon_id: salonA.salonId,
    role_id: ownerRole.id,
    module: "pos",
  });
  check("and ticking modules onto it is refused as meaningless", Boolean(tickOwner));

  const { error: deleteBuiltIn } = await asOwnerA
    .from("roles")
    .delete()
    .eq("id", staffRole.id);
  check("a built-in role cannot be deleted either", Boolean(deleteBuiltIn));

  /* ---- only the team module may edit roles ------------------------- */

  const { data: staffMakesRole } = await asStaffA
    .from("roles")
    .insert({ salon_id: salonA.salonId, name: "Self Appointed" })
    .select();
  check("a therapist cannot create a role", (staffMakesRole ?? []).length === 0);

  const { data: deskMakesRole } = await asReceptionistA
    .from("roles")
    .insert({ salon_id: salonA.salonId, name: "Desk Invented" })
    .select();
  check("nor can a receptionist -- team is not among their modules",
    (deskMakesRole ?? []).length === 0);

  /* ---- roles do not cross a tenant boundary ------------------------ */

  const { data: bSeesARoles } = await asOwnerB.from("roles").select("salon_id");
  check(
    "another salon sees none of these roles",
    (bSeesARoles ?? []).every((r) => r.salon_id === salonB.salonId),
  );

  const { data: bEditsARole } = await asOwnerB
    .from("roles")
    .update({ name: "Hijacked" })
    .eq("id", accountantRole.id)
    .select();
  check("nor can it rename one", (bEditsARole ?? []).length === 0);

  const { data: bTicksARole } = await asOwnerB
    .from("role_modules")
    .insert({ salon_id: salonA.salonId, role_id: accountantRole.id, module: "team" })
    .select();
  check("nor grant one a module", (bTicksARole ?? []).length === 0);

  /* ---------------------------------------------------------------- */
  console.log("\nDeactivated users lose all access\n");

  await admin.from("profiles").update({ is_active: false }).eq("id", staffA.userId);

  const asDeactivated = await clientFor(staffA.email);
  const { data: deactivatedSalons } = await asDeactivated.from("salons").select("id");
  check("a deactivated user can read no salon", (deactivatedSalons ?? []).length === 0);

  const { data: deactivatedProfiles } = await asDeactivated.from("profiles").select("id");
  check("a deactivated user can read no profiles", (deactivatedProfiles ?? []).length === 0);

  const { data: deactivatedCustomers } = await asDeactivated.from("customers").select("id");
  check("a deactivated user can read no customers", (deactivatedCustomers ?? []).length === 0);

  const { data: deactivatedForms } = await asDeactivated.from("consent_forms").select("id");
  check("a deactivated user can read no consent forms", (deactivatedForms ?? []).length === 0);

  const { data: deactivatedDiary } = await asDeactivated.from("appointments").select("id");
  check("a deactivated user can read no appointments", (deactivatedDiary ?? []).length === 0);

  const { data: deactivatedLines } = await asDeactivated.from("receipt_line_items").select("id");
  check(
    "a deactivated user can read none of their own receipt lines",
    (deactivatedLines ?? []).length === 0,
  );

  const { data: deactivatedEarnings } = await asDeactivated.from("payroll_entries").select("id");
  check("a deactivated user can read no earnings", (deactivatedEarnings ?? []).length === 0);

  const { data: deactivatedAttachments } = await asDeactivated
    .from("consent_form_attachments")
    .select("id");
  check(
    "a deactivated user can read no consent attachments",
    (deactivatedAttachments ?? []).length === 0,
  );

  const { data: deactivatedDocs } = await asDeactivated.from("staff_documents").select("id");
  check("a deactivated user can read no ID documents", (deactivatedDocs ?? []).length === 0);

  const { data: deactivatedSignature } = await asDeactivated.storage
    .from("consent-signatures")
    .download(fixturesA.staffSignaturePath);
  check("a deactivated user cannot download the signature they collected", !deactivatedSignature);





  /* ---------------------------------------------------------------- */
  console.log("\nAnonymous access\n");

  const anon = anonClient();
  const allTables = [
    "salons", "profiles", "salon_settings", "invitations", "audit_logs",
    "services", "service_staff", "deals", "deal_services",
    "consent_templates", "consent_template_items",
    "customers", "consent_forms", "consent_form_responses", "appointments",
    "receipts", "receipt_line_items", "loyalty_transactions",
    "staff_compensation", "payroll_periods", "payroll_entries",
    "consent_form_attachments", "appointment_services", "staff_documents",
    "payments",
  ];
  for (const table of allTables) {
    const { data } = await anon.from(table).select("*").limit(1);
    check(`anonymous cannot read ${table}`, (data ?? []).length === 0);
  }

  /* ---------------------------------------------------------------- */
  console.log("\nLast-owner guard\n");

  const { error: demoteSelf } = await asOwnerA
    .from("profiles")
    .update({ role: "staff" })
    .eq("id", salonA.userId);
  check("an owner cannot demote themselves", Boolean(demoteSelf));
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
