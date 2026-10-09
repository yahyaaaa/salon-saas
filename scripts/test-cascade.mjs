/**
 * Can a salon still be deleted?
 *
 * Rule 8 in CLAUDE.md, learned three times the hard way: a salon delete
 * cascades to its children in an unspecified order, one statement each, so a
 * table reachable only through a parent can still be holding a reference when
 * a sibling is checked. Every new tenant table needs its OWN
 * `salon_id references salons on delete cascade`.
 *
 *   npm run test:cascade
 *
 * This builds a throwaway salon carrying one row in each of the tables added
 * since that rule was written, then deletes it and says what survived.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const email = `cascade-${randomUUID().slice(0, 8)}@rls-test.local`;
const { data: created, error: userError } = await admin.auth.admin.createUser({
  email,
  password: `Cascade-${randomUUID().slice(0, 10)}!`,
  email_confirm: true,
  user_metadata: {
    full_name: "Cascade Probe",
    salon_name: `Cascade ${randomUUID().slice(0, 4)}`,
    business_type: "salon",
    country: "US",
    timezone: "UTC",
    currency: "USD",
  },
});
if (userError) throw new Error(`create user: ${userError.message}`);

const userId = created.user.id;
const { data: profile } = await admin
  .from("profiles")
  .select("salon_id, team_member_id")
  .eq("id", userId)
  .single();
const salonId = profile.salon_id;

/*
 * Since the Team/User split, "who performed the service" is a roster entry,
 * not a login. handle_new_user() creates one for a new salon's owner, which is
 * what this asserts -- a salon whose owner had no roster entry could not take
 * a booking at all.
 */
const rosterId = profile.team_member_id;
check("a new salon's owner lands on the roster", Boolean(rosterId));

try {
  const { data: service } = await admin
    .from("services")
    .insert({ salon_id: salonId, name: "Probe", price: 10, duration_minutes: 30 })
    .select("id")
    .single();

  const { data: customer } = await admin
    .from("customers")
    .insert({ salon_id: salonId, full_name: "Probe Customer", phone: `+1999${Date.now() % 10000000}` })
    .select("id")
    .single();

  const { data: appointment, error: apptError } = await admin
    .from("appointments")
    .insert({
      salon_id: salonId,
      customer_id: customer.id,
      staff_id: rosterId,
      service_id: service.id,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 1800000).toISOString(),
      price_at_booking: 10,
      is_walk_in: true,
    })
    .select("id")
    .single();
  check("the probe appointment is created", Boolean(appointment), apptError?.message);

  await admin.from("appointment_services").insert({
    salon_id: salonId,
    appointment_id: appointment.id,
    service_id: service.id,
    service_name: "Probe",
    quantity: 1,
    unit_price: 10,
    duration_minutes: 30,
  });

  // The tables added since rule 8 was written.
  await admin.from("staff_compensation").insert({
    staff_id: rosterId,
    salon_id: salonId,
    commission_type: "fixed_salary",
    commission_rate: 0,
    fixed_amount: 0,
    salary_amount: 1000,
    joining_date: null,
  });

  await admin.from("staff_documents").insert({
    salon_id: salonId,
    staff_id: rosterId,
    doc_type: "id_card",
    file_path: `${salonId}/probe.pdf`,
    file_name: "probe.pdf",
    mime_type: "application/pdf",
    size_bytes: 10,
    uploaded_by: userId,
  });

  // payments has no write policy, so it goes in with the service key directly
  // -- which the guard trigger permits for INSERT, refusing only edits.
  const { error: payError } = await admin.from("payments").insert({
    salon_id: salonId,
    customer_id: customer.id,
    appointment_id: appointment.id,
    kind: "deposit",
    method: "cash",
    amount: 5,
  });
  check("a payment can be seeded for the probe", !payError, payError?.message);

  const { error: deleteError } = await admin.from("salons").delete().eq("id", salonId);
  check("the salon deletes", !deleteError, deleteError?.message);

  const { count } = await admin
    .from("salons")
    .select("id", { count: "exact", head: true })
    .eq("id", salonId);
  check("and is gone", count === 0, `${count} row(s) left`);

  for (const table of [
    "team_members",
    "payments",
    "staff_documents",
    "staff_compensation",
    "appointment_services",
    "appointments",
    "customers",
    "services",
  ]) {
    const { count: left } = await admin
      .from(table)
      .select("salon_id", { count: "exact", head: true })
      .eq("salon_id", salonId);
    check(`${table} cascaded away`, left === 0, `${left} row(s) left`);
  }
} finally {
  await admin.from("salons").delete().eq("id", salonId);
  await admin.auth.admin.deleteUser(userId);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
