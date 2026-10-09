/**
 * Reporting and analytics.
 *
 * Reports are aggregations, which makes them easy to get subtly wrong and hard
 * to notice: a voided receipt quietly included, a late-evening sale counted on
 * the wrong day, "returning customer" meaning something different from what the
 * owner assumes. So this seeds a salon with figures chosen so every total has
 * one correct answer, and asserts that answer.
 *
 *   npm run test:reports
 *
 * The salon is deliberately in Asia/Karachi (UTC+5) rather than UTC, so any
 * report that buckets by the server's clock instead of the salon's fails here.
 *
 * Creates and deletes its own salon. Point it at a development project.
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

const PASSWORD = `Test-${randomUUID().slice(0, 12)}!`;
const TZ = "Asia/Karachi"; // UTC+5, no daylight saving
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

const money = (v) => Number(v).toFixed(2);

function eqMoney(name, actual, expected) {
  check(`${name} (${money(expected)})`, money(actual) === money(expected), `got ${money(actual)}`);
}

async function clientFor(email) {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return client;
}

async function makeUser(salonId, role, label) {
  const email = `${label}-${randomUUID().slice(0, 8)}@rls-test.local`;
  if (salonId) {
    const { error } = await admin.from("invitations").insert({ salon_id: salonId, email, role });
    if (error) throw new Error(`invite: ${error.message}`);
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: salonId
      ? { full_name: label }
      : {
          full_name: label,
          salon_name: `Report Salon ${randomUUID().slice(0, 4)}`,
          business_type: "salon",
          country: "PK",
          timezone: TZ,
          currency: "USD",
        },
  });
  if (error) throw new Error(`create ${label}: ${error.message}`);
  createdUserIds.push(data.user.id);
  // Two identities since the Team/User split: the login that acts, and the
  // roster entry that performs services and is reported on.
  const { data: profile } = await admin
    .from("profiles")
    .select("team_member_id")
    .eq("id", data.user.id)
    .single();

  return { email, userId: data.user.id, memberId: profile.team_member_id };
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

/**
 * Write a receipt at an exact instant.
 *
 * Goes in through the service-role client rather than create_receipt(), which
 * always stamps `now()`. Reporting needs history, so the rows are placed
 * directly — the arithmetic inside create_receipt() is tested in test-money.
 */
let receiptNumber = 0;
async function seedReceipt({
  salonId,
  customerId,
  staffId,
  serviceName,
  at,
  subtotal,
  discount = 0,
  redeemed = 0,
  earned = 0,
  status = "issued",
}) {
  receiptNumber += 1;
  const total = Number((subtotal - discount - redeemed).toFixed(2));
  const id = randomUUID();

  const { error } = await admin.from("receipts").insert({
    id,
    salon_id: salonId,
    receipt_number: receiptNumber,
    customer_id: customerId,
    subtotal,
    discount_total: discount,
    loyalty_redeemed: redeemed,
    total,
    loyalty_earned: earned,
    loyalty_earn_rate: 0.05,
    payment_method: "cash",
    cash_amount: total,
    card_amount: 0,
    status,
    void_reason: status === "voided" ? "test void" : null,
    voided_at: status === "voided" ? at : null,
    created_at: at,
  });
  if (error) throw new Error(`receipt: ${error.message}`);

  const { error: lineError } = await admin.from("receipt_line_items").insert({
    salon_id: salonId,
    receipt_id: id,
    service_name: serviceName,
    staff_id: staffId,
    quantity: 1,
    unit_price: subtotal,
    discount_amount: discount,
    line_total: Number((subtotal - discount).toFixed(2)),
    performed_at: at,
    sort_order: 0,
  });
  if (lineError) throw new Error(`receipt line: ${lineError.message}`);

  return id;
}

async function seedLoyalty(salonId, customerId, receiptId, type, amount, at) {
  const { error } = await admin.from("loyalty_transactions").insert({
    salon_id: salonId,
    customer_id: customerId,
    receipt_id: receiptId,
    type,
    amount,
    resulting_balance: amount,
    created_at: at,
  });
  if (error) throw new Error(`loyalty: ${error.message}`);
}

async function main() {
  console.log(`\nSetting up a salon in ${TZ} (UTC+5)\n`);

  const owner = await makeUser(null, "owner", "owner");
  const { data: profile } = await admin
    .from("profiles")
    .select("salon_id")
    .eq("id", owner.userId)
    .single();
  const salonId = profile.salon_id;
  createdSalonIds.push(salonId);

  const receptionist = await makeUser(salonId, "receptionist", "reception");
  const therapist1 = await makeUser(salonId, "staff", "amina");
  const therapist2 = await makeUser(salonId, "staff", "bilal");

  const ownerClient = await clientFor(owner.email);
  const deskClient = await clientFor(receptionist.email);
  const staffClient = await clientFor(therapist1.email);

  const { data: service } = await admin
    .from("services")
    .insert({ salon_id: salonId, name: "Facial", price: 100, duration_minutes: 60 })
    .select("id")
    .single();

  async function customer(name, phone) {
    const { data, error } = await admin
      .from("customers")
      .insert({ salon_id: salonId, full_name: name, phone })
      .select("id")
      .single();
    if (error) throw new Error(`customer ${name}: ${error.message}`);
    return data.id;
  }

  const alia = await customer("Alia", `+92300${randomUUID().slice(0, 7).replace(/\D/g, "1")}`);
  const bushra = await customer("Bushra", `+92301${randomUUID().slice(0, 7).replace(/\D/g, "2")}`);
  const chand = await customer("Chand", `+92302${randomUUID().slice(0, 7).replace(/\D/g, "3")}`);
  check("salon, team, service and three customers created", true);

  /*
   * The data, laid out deliberately. Reporting window is 10--15 March 2026.
   *
   *  Alia   01 Mar (before the window)   200  -> makes her RETURNING
   *         10 Mar 15:00 local           100
   *  Bushra 10 Mar 23:30 LOCAL           150  -> stored 18:30Z on the 10th
   *  Chand  11 Mar 00:30 LOCAL            80  -> stored 19:30Z on the 10th,
   *                                             so it must report on the 11th
   *  Alia   12 Mar  voided               999  -> must not appear anywhere
   */
  const instant = (localDate, localTime) => {
    // TZ is UTC+5 year-round, so the conversion is a fixed subtraction.
    const [h, m] = localTime.split(":").map(Number);
    const utc = new Date(`${localDate}T00:00:00.000Z`);
    utc.setUTCHours(h - 5, m, 0, 0);
    return utc.toISOString();
  };

  await seedReceipt({
    salonId, customerId: alia, staffId: therapist1.memberId, serviceName: "Facial",
    at: instant("2026-03-01", "12:00"), subtotal: 200, earned: 10,
  });
  const aliaSecond = await seedReceipt({
    salonId, customerId: alia, staffId: therapist1.memberId, serviceName: "Facial",
    at: instant("2026-03-10", "15:00"), subtotal: 100, discount: 10, redeemed: 5, earned: 4.25,
  });
  await seedReceipt({
    salonId, customerId: bushra, staffId: therapist2.memberId, serviceName: "Massage",
    at: instant("2026-03-10", "23:30"), subtotal: 150, earned: 7.5,
  });
  await seedReceipt({
    salonId, customerId: chand, staffId: therapist2.memberId, serviceName: "Massage",
    at: instant("2026-03-11", "00:30"), subtotal: 80, earned: 4,
  });
  await seedReceipt({
    salonId, customerId: alia, staffId: therapist1.memberId, serviceName: "Facial",
    at: instant("2026-03-12", "12:00"), subtotal: 999, earned: 49.95, status: "voided",
  });

  // Her 1 March visit earned credit too -- outside the reporting window, but it
  // is still money the salon owes her today.
  await seedLoyalty(salonId, alia, null, "earn", 10, instant("2026-03-01", "12:00"));
  await seedLoyalty(salonId, alia, aliaSecond, "earn", 4.25, instant("2026-03-10", "15:00"));
  await seedLoyalty(salonId, alia, aliaSecond, "redeem", -5, instant("2026-03-10", "15:00"));
  await seedLoyalty(salonId, bushra, null, "earn", 7.5, instant("2026-03-10", "23:30"));
  await seedLoyalty(salonId, chand, null, "earn", 4, instant("2026-03-11", "00:30"));

  // Appointments for the outcome and peak-hour reports.
  async function seedAppointment(staffId, customerId, localDate, localTime, status) {
    const starts = instant(localDate, localTime);
    const ends = new Date(new Date(starts).getTime() + 3_600_000).toISOString();
    const { error } = await admin.from("appointments").insert({
      salon_id: salonId,
      customer_id: customerId,
      staff_id: staffId,
      service_id: service.id,
      starts_at: starts,
      ends_at: ends,
      price_at_booking: 100,
      status,
      is_walk_in: true, // sidestep the overlap constraint for fixtures
      resolution_reason: ["cancelled", "no_show"].includes(status) ? "test" : null,
      resolved_at: ["cancelled", "no_show"].includes(status) ? starts : null,
    });
    if (error) throw new Error(`appointment: ${error.message}`);
  }

  await seedAppointment(therapist1.memberId, alia, "2026-03-10", "10:00", "completed");
  await seedAppointment(therapist1.memberId, bushra, "2026-03-10", "10:30", "completed");
  await seedAppointment(therapist1.memberId, chand, "2026-03-11", "10:00", "no_show");
  await seedAppointment(therapist2.memberId, alia, "2026-03-11", "14:00", "completed");
  await seedAppointment(therapist2.memberId, bushra, "2026-03-12", "14:00", "cancelled");
  // Just after midnight local: a different day AND hour from the UTC reading.
  await seedAppointment(therapist2.memberId, chand, "2026-03-11", "00:30", "booked");

  const FROM = "2026-03-10";
  const TO = "2026-03-15";

  /* ---------------------------------------------------------------- */
  console.log("\nReports are the owner's alone\n");

  for (const [label, client] of [
    ["a receptionist", deskClient],
    ["a therapist", staffClient],
  ]) {
    const { error } = await client.rpc("report_revenue_over_time", {
      p_from: FROM,
      p_to: TO,
      p_granularity: "day",
    });
    check(`${label} cannot run reports`, Boolean(error), error?.message?.slice(0, 60));
  }

  const { error: anonReport } = await anonClient().rpc("report_revenue_over_time", {
    p_from: FROM,
    p_to: TO,
    p_granularity: "day",
  });
  check("anonymous cannot run reports", Boolean(anonReport));

  /* ---------------------------------------------------------------- */
  console.log("\nRevenue over time, bucketed in the salon's timezone\n");

  const { data: daily, error: dailyError } = await ownerClient.rpc("report_revenue_over_time", {
    p_from: FROM,
    p_to: TO,
    p_granularity: "day",
  });
  check("the owner can run reports", !dailyError, dailyError?.message);

  const byDay = new Map((daily ?? []).map((row) => [row.bucket, row]));

  check("only the days with sales appear", (daily ?? []).length === 2, `got ${(daily ?? []).length}`);

  const mar10 = byDay.get("2026-03-10");
  const mar11 = byDay.get("2026-03-11");

  check("10 March has two receipts", Number(mar10?.receipt_count) === 2, `got ${mar10?.receipt_count}`);
  // 100 gross - 10 discount - 5 loyalty = 85, plus the 150 sale.
  eqMoney("10 March revenue", mar10?.revenue, 235);
  eqMoney("10 March gross", mar10?.gross, 250);
  eqMoney("10 March discounts", mar10?.discounts, 10);
  eqMoney("10 March loyalty redeemed", mar10?.loyalty_redeemed, 5);

  check(
    "the 00:30 local sale lands on 11 March, not 10 March",
    Number(mar11?.receipt_count) === 1,
    `got ${mar11?.receipt_count}`,
  );
  eqMoney("11 March revenue", mar11?.revenue, 80);

  const total = (daily ?? []).reduce((sum, r) => sum + Number(r.revenue), 0);
  eqMoney("the voided receipt is excluded from revenue entirely", total, 315);

  const { data: monthly } = await ownerClient.rpc("report_revenue_over_time", {
    p_from: FROM,
    p_to: TO,
    p_granularity: "month",
  });
  check("monthly granularity collapses to one bucket", (monthly ?? []).length === 1);
  eqMoney("and carries the same total", monthly?.[0]?.revenue, 315);

  // A window that starts before the earlier visit picks it up.
  const { data: wider } = await ownerClient.rpc("report_revenue_over_time", {
    p_from: "2026-03-01",
    p_to: TO,
    p_granularity: "month",
  });
  eqMoney("a wider window includes the earlier visit", wider?.[0]?.revenue, 515);

  /* ---------------------------------------------------------------- */
  console.log("\nRevenue by service and by staff member\n");

  const { data: byService } = await ownerClient.rpc("report_revenue_by_service", {
    p_from: FROM,
    p_to: TO,
  });
  const facial = (byService ?? []).find((r) => r.service_name === "Facial");
  const massage = (byService ?? []).find((r) => r.service_name === "Massage");
  check("two services sold in the window", (byService ?? []).length === 2);
  eqMoney("facial revenue is net of its discount", facial?.revenue, 90);
  eqMoney("massage revenue", massage?.revenue, 230);
  check("the voided facial is not counted", Number(facial?.quantity) === 1);

  const { data: byStaff } = await ownerClient.rpc("report_revenue_by_staff", {
    p_from: FROM,
    p_to: TO,
  });
  const amina = (byStaff ?? []).find((r) => r.staff_id === therapist1.memberId);
  const bilal = (byStaff ?? []).find((r) => r.staff_id === therapist2.memberId);

  /*
   * The report must NAME them, not just count them.
   *
   * This exists because the figures kept coming out right while the names
   * silently did not: the name was resolved against `profiles` by staff_id,
   * and after the Team/User split that join matched nothing, so every row fell
   * through to the 'Former team member' fallback. A suite that only checked
   * revenue would have shipped a report of anonymous rows.
   */
  check(
    "the report names the person, rather than falling back",
    amina?.staff_name === "amina" && bilal?.staff_name === "bilal",
    `got "${amina?.staff_name}" and "${bilal?.staff_name}"`,
  );
  eqMoney("first therapist revenue", amina?.revenue, 90);
  eqMoney("second therapist revenue", bilal?.revenue, 230);
  check("staff are named", Boolean(amina?.staff_name) && Boolean(bilal?.staff_name));

  /* ---------------------------------------------------------------- */
  console.log("\nCustomer retention\n");

  const { data: retention } = await ownerClient.rpc("report_customer_retention", {
    p_from: FROM,
    p_to: TO,
  });
  const r = retention?.[0];
  check("two new customers in the window", Number(r?.new_customers) === 2, `got ${r?.new_customers}`);
  check(
    "one returning customer (she first visited on 1 March)",
    Number(r?.returning_customers) === 1,
    `got ${r?.returning_customers}`,
  );
  check("three customers in total", Number(r?.total_customers) === 3);
  check("repeat rate is one in three", Number(r?.repeat_rate).toFixed(4) === "0.3333");
  check("three visits counted", Number(r?.visits) === 3, `got ${r?.visits}`);

  // Widen the window and the same customer becomes new, because her first
  // visit now falls inside it.
  const { data: widerRetention } = await ownerClient.rpc("report_customer_retention", {
    p_from: "2026-03-01",
    p_to: TO,
  });
  check(
    "widening the window reclassifies her as new",
    Number(widerRetention?.[0]?.new_customers) === 3 &&
      Number(widerRetention?.[0]?.returning_customers) === 0,
  );

  /* ---------------------------------------------------------------- */
  console.log("\nAppointment outcomes\n");

  const { data: stats } = await ownerClient.rpc("report_appointment_stats", {
    p_from: FROM,
    p_to: TO,
  });
  const s1 = (stats ?? []).find((row) => row.staff_id === therapist1.memberId);
  const s2 = (stats ?? []).find((row) => row.staff_id === therapist2.memberId);

  check(
    "appointment stats name the person too",
    s1?.staff_name === "amina" && s2?.staff_name === "bilal",
    `got "${s1?.staff_name}" and "${s2?.staff_name}"`,
  );

  check("first therapist: two completed", Number(s1?.completed) === 2, `got ${s1?.completed}`);
  check("first therapist: one no-show", Number(s1?.no_show) === 1);
  check("first therapist: three total", Number(s1?.total) === 3);
  check(
    "first therapist: no-show rate is one in three",
    Number(s1?.no_show_rate).toFixed(4) === "0.3333",
  );
  check("second therapist: one cancelled", Number(s2?.cancelled) === 1);
  check("second therapist: one still booked", Number(s2?.booked) === 1);
  check("second therapist: one completed", Number(s2?.completed) === 1);

  /* ---------------------------------------------------------------- */
  console.log("\nLoyalty programme cost\n");

  const { data: loyalty } = await ownerClient.rpc("report_loyalty_cost", {
    p_from: FROM,
    p_to: TO,
  });
  const l = loyalty?.[0];
  eqMoney("credit issued in the window", l?.issued, 15.75);
  eqMoney("credit redeemed, reported positive", l?.redeemed, 5);
  eqMoney("net movement in the liability", l?.net_change, 10.75);
  // 10 + 4.25 - 5 for Alia, 7.5 for Bushra, 4 for Chand. Note this is the whole
  // programme to date, not the window: a liability does not reset each month.
  eqMoney("outstanding balance across the programme", l?.outstanding_balance, 20.75);
  check("three customers hold a balance", Number(l?.customers_with_balance) === 3);

  // A customer can end up owing the salon, if a voided receipt claws back
  // credit they had already spent. That is a debt, not a liability the salon
  // owes, so it must not be netted off against everyone else's balances.
  const dua = await customer("Dua", `+92303${randomUUID().slice(0, 7).replace(/\D/g, "4")}`);
  await seedLoyalty(salonId, dua, null, "void_reversal", -6, instant("2026-03-12", "12:00"));

  const { data: afterDebt } = await ownerClient.rpc("report_loyalty_cost", {
    p_from: FROM,
    p_to: TO,
  });
  eqMoney(
    "a negative balance is not netted off the liability",
    afterDebt?.[0]?.outstanding_balance,
    20.75,
  );
  check(
    "and that customer is not counted as holding credit",
    Number(afterDebt?.[0]?.customers_with_balance) === 3,
    `got ${afterDebt?.[0]?.customers_with_balance}`,
  );
  eqMoney(
    "but the clawback does show as an adjustment in the period",
    afterDebt?.[0]?.adjustments,
    -6,
  );

  /* ---------------------------------------------------------------- */
  console.log("\nPeak times\n");

  const { data: peaks } = await ownerClient.rpc("report_peak_times", {
    p_from: FROM,
    p_to: TO,
  });

  // Cancelled is excluded; the no-show is kept.
  const totalPeaks = (peaks ?? []).reduce((sum, row) => sum + Number(row.appointments), 0);
  check("cancelled appointments are excluded", totalPeaks === 5, `counted ${totalPeaks}`);

  const tenAm = (peaks ?? []).filter((row) => row.hour_of_day === 10);
  check(
    "10am is the busiest hour",
    tenAm.reduce((sum, row) => sum + Number(row.appointments), 0) === 3,
  );

  // 11 March 2026 is a Wednesday; 00:30 local is 19:30Z on Tuesday the 10th.
  // Bucketing by the salon's clock must put it on Wednesday at hour 0.
  const midnightSlot = (peaks ?? []).find((row) => row.hour_of_day === 0);
  check("the 00:30 local booking is reported at hour 0", Boolean(midnightSlot));
  check(
    "and on Wednesday (weekday 2), not Tuesday",
    Number(midnightSlot?.weekday) === 2,
    `got weekday ${midnightSlot?.weekday}`,
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
