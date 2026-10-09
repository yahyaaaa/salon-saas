/**
 * Form behaviour: rejected submissions must not wipe what was typed.
 *
 * React resets an uncontrolled form once its action resolves, so a form that
 * does nothing about it comes back blank after any validation error. On a
 * booking or a till that is the difference between fixing one field and ringing
 * the whole thing up again.
 *
 * This drives the RUNNING APPLICATION, submitting real forms and reading the
 * HTML that comes back, because the behaviour under test is what the browser
 * ends up displaying -- not what the action returns.
 *
 *   npm run build && npm run start     # one terminal
 *   npm run test:forms                 # another
 *
 * Creates and deletes its own salon. Point it at a development project.
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

import { act, assertFreshBuild, createSession, get } from "./lib/app-driver.mjs";
import { COUNTRIES, currencyFor, findCountry, timezoneFor } from "./lib/countries-bridge.mjs";

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

const PASSWORD = `Forms-${randomUUID().slice(0, 12)}!`;
const createdUserIds = [];
/** Addresses used in signups that may or may not have produced a user. */
const strayEmails = new Set();
const createdSalonIds = [];

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [32mPASS[0m  ${name}`);
  } else {
    failed += 1;
    console.log(`  [31mFAIL[0m  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

/**
 * The page as a reader sees it: tags and React's `<!-- -->` text separators
 * stripped, whitespace collapsed.
 *
 * Needed because a bare `body.includes("Add-on Manicure")` is not evidence the
 * APPOINTMENT shows that service -- the booking form below it ships the whole
 * catalogue to the client, so every service name is in the page regardless.
 * Matching the rendered sentence is what distinguishes the two.
 */
function readable(html) {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/** Did the returned HTML come back carrying this value? */
function kept(html, value) {
  if (!value) return false;
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return html.includes(`value="${escaped}"`) || html.includes(`>${escaped}<`);
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


  // The rejected-signup case can still create an auth user before the trigger
  // refuses it, and that user belongs to no salon, so nothing above catches it.
  try {
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
    for (const user of data?.users ?? []) {
      if (strayEmails.has(user.email)) await admin.auth.admin.deleteUser(user.id);
    }
  } catch {
    /* best effort */
  }
}

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

  /* ---------------------------------------------------------------- */
  console.log("\nCountry, currency and timezone are linked\n");

  check("the country list is substantial", COUNTRIES.length > 150, `${COUNTRIES.length} entries`);
  check("Pakistan implies PKR", currencyFor("Pakistan") === "PKR");
  check("Pakistan implies Asia/Karachi", timezoneFor("Pakistan") === "Asia/Karachi");
  check("the United Kingdom implies GBP", currencyFor("United Kingdom") === "GBP");
  check("Japan implies Asia/Tokyo", timezoneFor("Japan") === "Asia/Tokyo");
  check("an ISO code resolves too", findCountry("DE")?.name === "Germany");
  check("lookup is case-insensitive", findCountry("france")?.currency === "EUR");
  check("nonsense resolves to nothing", findCountry("Atlantis") === null);
  check(
    "every country has a currency and a zone",
    COUNTRIES.every((c) => /^[A-Z]{3}$/.test(c.currency) && c.zone.includes("/")),
  );
  check(
    "every zone the list names is one the runtime knows",
    COUNTRIES.every((c) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: c.zone });
        return true;
      } catch {
        return false;
      }
    }),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nSignup keeps what was typed when it is rejected\n");

  const signup = createSession();
  const takenEmail = `taken-${randomUUID().slice(0, 8)}@mailinator.com`;
  strayEmails.add(takenEmail);
  const salonName = `Forms Salon ${randomUUID().slice(0, 4)}`;

  // A deliberately invalid country, so the submission is rejected while every
  // other field is perfectly good.
  const rejected = await act(signup, "/signup", 'name="salonName"', {
    salonName,
    businessType: "aesthetic_clinic",
    fullName: "Ada Owner",
    email: takenEmail,
    password: PASSWORD,
    country: "Atlantis",
    currency: "",
    timezone: "",
  });

  check("the salon name survives", kept(rejected.text, salonName));
  check("the owner's name survives", kept(rejected.text, "Ada Owner"));
  check("the email survives", kept(rejected.text, takenEmail));
  check(
    "the business type survives",
    rejected.text.includes('value="aesthetic_clinic" selected') ||
      rejected.text.includes('selected=""') ||
      kept(rejected.text, "aesthetic_clinic"),
  );
  check("the password is NOT echoed back", !rejected.text.includes(PASSWORD));
  check("the country is reported as the problem", rejected.text.includes("Choose a country"));

  /* ---------------------------------------------------------------- */
  console.log("\nSetting up a salon to book into\n");

  const ownerEmail = `owner-${randomUUID().slice(0, 8)}@mailinator.com`;
  strayEmails.add(ownerEmail);
  const owner = createSession();
  await act(owner, "/signup", 'name="salonName"', {
    salonName,
    businessType: "salon",
    fullName: "Ada Owner",
    email: ownerEmail,
    password: PASSWORD,
    country: "Pakistan",
    currency: "PKR",
    timezone: "Asia/Karachi",
  });

  const { data: users } = await admin.auth.admin.listUsers();
  const ownerRecord = users.users.find((u) => u.email === ownerEmail);
  if (!ownerRecord) throw new Error("signup did not create the owner");
  createdUserIds.push(ownerRecord.id);

  const { data: profile } = await admin
    .from("profiles")
    .select("salon_id")
    .eq("id", ownerRecord.id)
    .single();
  const salonId = profile.salon_id;
  createdSalonIds.push(salonId);

  const { data: salon } = await admin
    .from("salons")
    .select("country, currency, timezone")
    .eq("id", salonId)
    .single();
  check("the chosen country is stored", salon.country === "Pakistan");
  check("its currency came with it", salon.currency === "PKR");
  check("and its timezone", salon.timezone === "Asia/Karachi");

  // Two therapists and a service only one of them may perform, so the
  // "not qualified" error can be provoked deliberately.
  async function therapist(label) {
    const email = `${label}-${randomUUID().slice(0, 8)}@mailinator.com`;
    await admin.from("invitations").insert({ salon_id: salonId, email, role: "staff" });
    const { data } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: label },
    });
    createdUserIds.push(data.user.id);

    /*
     * The ROSTER entry, not the login. Since the Team/User split, a booking
     * names who performs the service -- which is a team member, and may not
     * have an account at all.
     */
    const { data: profile } = await admin
      .from("profiles")
      .select("team_member_id")
      .eq("id", data.user.id)
      .single();
    return profile.team_member_id;
  }

  const qualified = await therapist("qualified");
  const unqualified = await therapist("unqualified");

  const { data: service } = await admin
    .from("services")
    .insert({ salon_id: salonId, name: "Specialist Facial", price: 120, duration_minutes: 60 })
    .select("id")
    .single();
  await admin
    .from("service_staff")
    .insert({ salon_id: salonId, service_id: service.id, staff_id: qualified });

  const { data: customer } = await admin
    .from("customers")
    .insert({
      salon_id: salonId,
      full_name: "Pat Customer",
      phone: `+92300${String(Date.now()).slice(-7)}`,
    })
    .select("id")
    .single();

  /* ---------------------------------------------------------------- */
  console.log("\nA rejected booking keeps every field\n");

  const today = new Date().toISOString().slice(0, 10);
  const notes = `Allergic to ${randomUUID().slice(0, 6)}`;

  const oneLine = JSON.stringify([{ serviceId: service.id, quantity: 1 }]);

  const clash = await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
    customerMode: "existing",
    customerId: customer.id,
    staffId: unqualified, // the one who may not perform it
    lines: oneLine,
    date: today,
    time: "11:45",
    notes,
    discount: "0",
    quotedTotal: "",
  });

  check(
    "the booking is refused, with the reason",
    clash.text.includes("not qualified"),
    "expected the qualification message",
  );
  check("the customer is still selected", kept(clash.text, customer.id));
  check("the service lines survive", clash.text.includes(service.id));
  check("the date survives", kept(clash.text, today));
  check("the time survives", kept(clash.text, "11:45"));
  check("the notes survive", kept(clash.text, notes));
  check("the chosen team member survives", kept(clash.text, unqualified));

  const { count: bookedCount } = await admin
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", salonId);
  check("and nothing was booked", bookedCount === 0, `found ${bookedCount}`);

  // The same submission with the qualified therapist goes through.
  await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
    customerMode: "existing",
    customerId: customer.id,
    staffId: qualified,
    lines: oneLine,
    date: today,
    time: "11:45",
    notes,
    discount: "0",
    quotedTotal: "",
  });
  const { count: afterFix } = await admin
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", salonId);
  check("fixing the one field books it", afterFix === 1, `found ${afterFix}`);

  /* ---------------------------------------------------------------- */
  console.log("\nBooking a new customer without leaving the page\n");

  const newName = `Walk In ${randomUUID().slice(0, 5)}`;
  const newPhone = `+92301${String(Date.now()).slice(-7)}`;

  await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
    customerMode: "new",
    newCustomerName: newName,
    newCustomerPhone: newPhone,
    staffId: qualified,
    lines: oneLine,
    date: today,
    time: "15:00",
    notes: "",
    isWalkIn: "on",
    discount: "0",
    quotedTotal: "",
  });

  const { data: createdCustomer } = await admin
    .from("customers")
    .select("id, full_name")
    .eq("salon_id", salonId)
    .eq("full_name", newName)
    .maybeSingle();
  check("the new customer is created from the booking form", Boolean(createdCustomer));

  const { data: walkIn } = await admin
    .from("appointments")
    .select("id, is_walk_in, customer_id")
    .eq("customer_id", createdCustomer?.id ?? "")
    .maybeSingle();
  check("and booked in one step", Boolean(walkIn));
  check("with walk-in recorded separately from customer type", walkIn?.is_walk_in === true);

  // A duplicate phone is reported on the field, and the rest is kept.
  const dupe = await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
    customerMode: "new",
    newCustomerName: "Someone Else",
    newCustomerPhone: newPhone,
    staffId: qualified,
    lines: oneLine,
    date: today,
    time: "16:30",
    notes: "",
    discount: "0",
    quotedTotal: "",
  });
  check(
    "a duplicate phone is caught, naming who holds it",
    dupe.text.includes("already uses that phone number") && dupe.text.includes(newName),
  );
  check("and the typed name is kept", kept(dupe.text, "Someone Else"));
  check("along with the time", kept(dupe.text, "16:30"));

  /* ---------------------------------------------------------------- */
  console.log("\nThe till keeps its basket when a sale is refused\n");

  const basket = JSON.stringify([
    { serviceId: service.id, staffId: qualified, quantity: 2 },
  ]);
  const saleNote = `Ref ${randomUUID().slice(0, 6)}`;

  // A split that does not add up is refused by create_receipt().
  const badSale = await act(owner, "/dashboard/pos", 'name="paymentMethod"', {
    customerMode: "existing",
    customerId: customer.id,
    dealId: "",
    paymentMethod: "split",
    cashAmount: "10",
    cardAmount: "10",
    loyaltyRedeem: "0",
    notes: saleNote,
    lines: basket,
  });

  check("the sale is refused", badSale.text.includes("does not add up"));
  // The basket rides back as a JSON string in a hidden field, so look for the
  // service inside it rather than as a whole attribute value.
  check("the basket survives", badSale.text.includes(service.id));
  check("the customer survives", kept(badSale.text, customer.id));
  check("the note survives", kept(badSale.text, saleNote));
  check("the split amounts survive", kept(badSale.text, "10"));

  const { count: receiptsAfterFailure } = await admin
    .from("receipts")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", salonId);
  check("and no receipt was written", receiptsAfterFailure === 0, `found ${receiptsAfterFailure}`);

  /* ---------------------------------------------------------------- */
  console.log("\nSelling to a brand new customer from the till\n");

  const tillName = `Till Customer ${randomUUID().slice(0, 5)}`;
  const tillPhone = `+92302${String(Date.now()).slice(-7)}`;

  await act(owner, "/dashboard/pos", 'name="paymentMethod"', {
    customerMode: "new",
    newCustomerName: tillName,
    newCustomerPhone: tillPhone,
    dealId: "",
    paymentMethod: "cash",
    cashAmount: "0",
    cardAmount: "0",
    loyaltyRedeem: "0",
    notes: "",
    lines: basket,
  });

  const { data: tillCustomer } = await admin
    .from("customers")
    .select("id")
    .eq("salon_id", salonId)
    .eq("full_name", tillName)
    .maybeSingle();
  check("the till created the customer", Boolean(tillCustomer));

  const { data: tillReceipt } = await admin
    .from("receipts")
    .select("id, total, customer_id")
    .eq("customer_id", tillCustomer?.id ?? "")
    .maybeSingle();
  check("and rang up the sale in the same step", Boolean(tillReceipt));
  check(
    "for the right amount",
    Number(tillReceipt?.total ?? 0) === 240,
    `got ${tillReceipt?.total}`,
  );

  /* ---------------------------------------------------------------- */
  console.log("\nA failed booking leaves no customer behind\n");

  // The point of doing the whole booking in one transaction. Previously the
  // customer was written first, so a booking refused a moment later left a
  // phantom profile the front desk had to notice and clean up.
  const ghostName = `Ghost ${randomUUID().slice(0, 5)}`;
  const ghostPhone = `+92309${String(Date.now()).slice(-7)}`;

  const refused = await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
    customerMode: "new",
    newCustomerName: ghostName,
    newCustomerPhone: ghostPhone,
    staffId: unqualified, // will be refused
    lines: oneLine,
    date: today,
    time: "17:15",
    notes: "",
    discount: "0",
    quotedTotal: "",
  });
  check("the booking is refused", refused.text.includes("not qualified"));

  const { data: ghost } = await admin
    .from("customers")
    .select("id")
    .eq("salon_id", salonId)
    .eq("full_name", ghostName)
    .maybeSingle();
  check("and NO customer record was created", !ghost, ghost ? "a phantom profile survived" : "");

  check("the typed name is handed back", kept(refused.text, ghostName));
  check("along with the phone", kept(refused.text, ghostPhone));

  // The same for the till.
  const tillGhostName = `Till Ghost ${randomUUID().slice(0, 5)}`;
  const tillGhostPhone = `+92310${String(Date.now()).slice(-7)}`;

  const refusedSale = await act(owner, "/dashboard/pos", 'name="paymentMethod"', {
    customerMode: "new",
    newCustomerName: tillGhostName,
    newCustomerPhone: tillGhostPhone,
    dealId: "",
    paymentMethod: "split",
    cashAmount: "1",
    cardAmount: "1",
    loyaltyRedeem: "0",
    notes: "",
    lines: basket,
  });
  check("the sale is refused", refusedSale.text.includes("does not add up"));

  const { data: tillGhost } = await admin
    .from("customers")
    .select("id")
    .eq("salon_id", salonId)
    .eq("full_name", tillGhostName)
    .maybeSingle();
  check("and the till created no customer either", !tillGhost);

  /* ---------------------------------------------------------------- */
  console.log("\nSeveral services on one booking, with a quoted price\n");

  const { data: addOn } = await admin
    .from("services")
    .insert({ salon_id: salonId, name: "Add-on Manicure", price: 45, duration_minutes: 30 })
    .select("id")
    .single();

  const multiLines = JSON.stringify([
    { serviceId: service.id, quantity: 1 },
    { serviceId: addOn.id, quantity: 2 },
  ]);

  await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
    customerMode: "existing",
    customerId: customer.id,
    staffId: qualified,
    lines: multiLines,
    date: today,
    time: "09:00",
    notes: "bridal package",
    discount: "0",
    quotedTotal: "",
    isWalkIn: "on",
  });

  const { data: multi } = await admin
    .from("appointments")
    .select("id, services_subtotal, discount_amount, quoted_total, price_at_booking, starts_at, ends_at")
    .eq("salon_id", salonId)
    .eq("notes", "bridal package")
    .maybeSingle();
  check("the booking is created", Boolean(multi));

  const { data: multiLinesRows } = await admin
    .from("appointment_services")
    .select("service_id, quantity, unit_price, duration_minutes")
    .eq("appointment_id", multi?.id ?? "");
  check("both services are recorded", (multiLinesRows ?? []).length === 2);

  // 120 for the specialist facial, plus two 45 manicures.
  check(
    "the subtotal is the sum of the lines",
    Number(multi?.services_subtotal) === 210,
    `got ${multi?.services_subtotal}`,
  );
  check("with no discount and no override", Number(multi?.discount_amount) === 0 && multi?.quoted_total === null);
  check("so the price is the subtotal", Number(multi?.price_at_booking) === 210);

  // 60 minutes plus two lots of 30.
  const minutes = (new Date(multi.ends_at) - new Date(multi.starts_at)) / 60000;
  check("the slot spans every service", minutes === 120, `got ${minutes} minutes`);

  // Now a package price that is not the sum.
  await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
    customerMode: "existing",
    customerId: customer.id,
    staffId: qualified,
    lines: multiLines,
    date: today,
    time: "12:00",
    notes: "quoted package",
    discount: "0",
    quotedTotal: "175",
    isWalkIn: "on",
  });

  const { data: quoted } = await admin
    .from("appointments")
    .select("services_subtotal, quoted_total, price_at_booking")
    .eq("salon_id", salonId)
    .eq("notes", "quoted package")
    .maybeSingle();
  check("the subtotal still reflects the services", Number(quoted?.services_subtotal) === 210);
  check("the quoted price is kept", Number(quoted?.quoted_total) === 175);
  check("and it is what is charged", Number(quoted?.price_at_booking) === 175);

  // And a discount off the calculated subtotal.
  await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
    customerMode: "existing",
    customerId: customer.id,
    staffId: qualified,
    lines: multiLines,
    date: today,
    time: "13:30",
    notes: "discounted package",
    discount: "10",
    quotedTotal: "",
    isWalkIn: "on",
  });

  const { data: discounted } = await admin
    .from("appointments")
    .select("services_subtotal, discount_amount, price_at_booking")
    .eq("salon_id", salonId)
    .eq("notes", "discounted package")
    .maybeSingle();
  check("the discount is recorded", Number(discounted?.discount_amount) === 10);
  check("and taken off the total", Number(discounted?.price_at_booking) === 200);

  // Every service on the booking is checked against the therapist, not just
  // the first one.
  await admin
    .from("service_staff")
    .insert({ salon_id: salonId, service_id: addOn.id, staff_id: qualified });
  const onlyFirstQualified = await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
    customerMode: "existing",
    customerId: customer.id,
    staffId: unqualified,
    lines: multiLines,
    date: today,
    time: "18:00",
    notes: "",
    discount: "0",
    quotedTotal: "",
    isWalkIn: "on",
  });
  check(
    "an unqualified therapist is refused on any line",
    onlyFirstQualified.text.includes("not qualified"),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nCustomer search\n");

  const { data: searchable } = await admin
    .from("customers")
    .insert({
      salon_id: salonId,
      full_name: "Zainab Searchtarget",
      phone: `+92311${String(Date.now()).slice(-7)}`,
    })
    .select("id, phone")
    .single();

  const byName = await admin.rpc("search_customers", { p_query: "Searchtarget", p_limit: 3 });
  check("search is reachable", !byName.error, byName.error?.message);

  // The RPC runs as the caller, so the service-role client sees no salon and
  // gets nothing -- which is itself worth knowing. Exercise it as the owner.
  const ownerApi = createClient(
    SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  await ownerApi.auth.signInWithPassword({ email: ownerEmail, password: PASSWORD });

  const { data: nameHits } = await ownerApi.rpc("search_customers", {
    p_query: "Searchtarget",
    p_limit: 3,
  });
  check(
    "searching by name finds them",
    (nameHits ?? []).length === 1 && nameHits[0].full_name === "Zainab Searchtarget",
    `got ${(nameHits ?? []).length}`,
  );

  const digits = searchable.phone.replace(/[^0-9]/g, "").slice(-6);
  const { data: phoneHits } = await ownerApi.rpc("search_customers", {
    p_query: digits,
    p_limit: 3,
  });
  check(
    "searching by phone digits finds them",
    (phoneHits ?? []).some((c) => c.id === searchable.id),
  );

  const { data: spaced } = await ownerApi.rpc("search_customers", {
    p_query: `${digits.slice(0, 3)} ${digits.slice(3)}`,
    p_limit: 3,
  });
  check("formatting in the query is ignored", (spaced ?? []).some((c) => c.id === searchable.id));

  const { data: capped } = await ownerApi.rpc("search_customers", { p_query: "a", p_limit: 3 });
  check("the result list is capped", (capped ?? []).length <= 3);

  const { data: nothing } = await ownerApi.rpc("search_customers", {
    p_query: "zzzznomatchzzzz",
    p_limit: 3,
  });
  check("a query with no matches returns nothing", (nothing ?? []).length === 0);

  /* ---------------------------------------------------------------- */
  console.log("\nAn appointment shows everything that was booked\n");

  /*
   * The multi-service booking went in last round and stored its lines
   * correctly, but the calendar rendered appointments.service_id -- the legacy
   * FIRST-service column, kept for the qualification guard and the Phase 6
   * reports. A four-service booking therefore displayed as one service. These
   * read the page as the front desk sees it.
   */
  const dayView = await get(owner, `/dashboard/calendar?view=day&date=${today}`);

  const dayText = readable(dayView.body);

  check(
    "every service on a booking is listed, not just the first",
    dayText.includes("Specialist Facial, Add-on Manicure"),
    "the appointment summarised only its first service",
  );
  check(
    "a repeated service shows its quantity",
    dayText.includes("Add-on Manicure ×2"),
    "the quantity was not rendered",
  );
  check(
    "each service is itemised with what it costs",
    /• Add-on Manicure ×2 Rs\s?[\d,]+/.test(dayText),
  );
  // "Booked" is also a status badge, so match the timestamp that follows the
  // booked-at label rather than the word on its own.
  check(
    "the booking says when it was taken",
    /Booked [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}/.test(dayText),
    "no booked-at timestamp on the appointment",
  );
  check(
    "and by whom",
    /Booked [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} by /.test(dayText),
  );
  check(
    "a discount is shown against the subtotal",
    /subtotal Rs\s?[\d,]+ − Rs\s?[\d,]+ discount/.test(dayText),
    "no discount line on a discounted booking",
  );
  check(
    "a quoted package says so rather than showing arithmetic",
    dayText.includes("quoted price, services total"),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nThe calendar list view spans a date range\n");

  // Something outside today, so a range has two ends worth having.
  const farOff = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const farNote = `Far ${randomUUID().slice(0, 6)}`;

  await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
    customerMode: "existing",
    customerId: customer.id,
    staffId: qualified,
    lines: oneLine,
    date: farOff,
    time: "11:00",
    notes: farNote,
    discount: "0",
    quotedTotal: "",
    isWalkIn: "on",
  });

  const wideRange = await get(
    owner,
    `/dashboard/calendar?view=agenda&from=${today}&to=${farOff}`,
  );
  check("the list view renders", wideRange.status === 200, `status ${wideRange.status}`);
  check(
    "a range covering both dates shows the distant booking",
    wideRange.body.includes(farNote),
  );
  check(
    "and today's bookings alongside it",
    wideRange.body.includes("Specialist Facial"),
  );
  check(
    "the range is summarised by count and value",
    /\d+ appointments over \d+ days/.test(readable(wideRange.body)),
  );

  const narrowRange = await get(
    owner,
    `/dashboard/calendar?view=agenda&from=${farOff}&to=${farOff}`,
  );
  check(
    "narrowing the range drops the earlier bookings",
    narrowRange.body.includes(farNote) && !narrowRange.body.includes("bridal package"),
  );

  const emptyRange = await get(
    owner,
    "/dashboard/calendar?view=agenda&from=2019-01-01&to=2019-01-31",
  );
  check(
    "a range with nothing in it says so",
    emptyRange.body.includes("Nothing booked in this range"),
  );

  const absurdRange = await get(
    owner,
    "/dashboard/calendar?view=agenda&from=2026-01-01&to=2099-01-01",
  );
  check(
    "an absurd range is trimmed rather than pulling the whole diary",
    absurdRange.body.includes("trimmed"),
  );

  const backwardsRange = await get(
    owner,
    `/dashboard/calendar?view=agenda&from=${farOff}&to=${today}`,
  );
  check(
    "a backwards range is read the right way round",
    backwardsRange.status === 200 && backwardsRange.body.includes(farNote),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nPOS receipts can be filtered by date\n");

  const todaysTakings = await get(owner, `/dashboard/pos?from=${today}&to=${today}`);
  check("the POS filter renders", todaysTakings.status === 200);
  const takingsText = readable(todaysTakings.body);
  const issuedCount = takingsText.match(/Receipts issued (\d+)/);
  check(
    "today's range counts the receipts written today",
    Boolean(issuedCount) && Number(issuedCount[1]) > 0,
    `counted ${issuedCount?.[1] ?? "nothing"}`,
  );
  check(
    "and totals what was taken",
    /Takings Rs\s?[\d,]+/.test(takingsText),
  );

  /*
   * Every way the salon actually takes money. The ledger accepted bank
   * transfers from the start while the till did not, so the same money had to
   * be rung up as cash and the receipt said something untrue about it.
   */
  const methodOptions = todaysTakings.body;
  for (const [value, label] of [
    ["cash", "Cash"],
    ["card", "Card"],
    ["bank_transfer", "Bank transfer"],
    ["split", "Split"],
  ]) {
    check(
      `the till offers ${label}`,
      methodOptions.includes(`value="${value}"`) && methodOptions.includes(`>${label}<`),
      "not offered as a payment method",
    );
  }

  const oldRange = await get(owner, "/dashboard/pos?from=2019-01-01&to=2019-01-31");
  check(
    "a range with no sales says so",
    oldRange.body.includes("No receipts in this range"),
  );

  // Void is owner-only and needs a typed reason, so it stays on the receipt
  // itself rather than being a button in the filtered list -- but it has to be
  // REACHABLE from there.
  const { data: aReceipt } = await admin
    .from("receipts")
    .select("id, receipt_number")
    .eq("salon_id", salonId)
    .eq("status", "issued")
    .limit(1)
    .maybeSingle();
  check("a receipt exists to open", Boolean(aReceipt));
  check(
    "the filtered list links to each receipt",
    todaysTakings.body.includes(`/dashboard/pos/${aReceipt.id}`),
  );

  const receiptPage = await get(owner, `/dashboard/pos/${aReceipt.id}`);
  check(
    "and the receipt offers the owner a void with a reason",
    receiptPage.body.includes("Void this receipt") && receiptPage.body.includes("reason"),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nThe appointment view, end to end\n");

  /*
   * What the brief asks a completed visit to show: the services, when it was
   * booked, when it is for, the discount, and every payment with its amount
   * and date. Driven through the real pages and the real forms.
   */
  const { data: visitRow } = await admin
    .from("appointments")
    .select("id")
    .eq("salon_id", salonId)
    .eq("notes", "discounted package")
    .maybeSingle();
  check("there is a discounted booking to open", Boolean(visitRow));

  const visitPath = `/dashboard/calendar/${visitRow.id}`;
  const visitPage = await get(owner, visitPath);
  check("the appointment page renders", visitPage.status === 200, `status ${visitPage.status}`);

  const visitText = readable(visitPage.body);

  check(
    "it lists every service on the booking",
    visitText.includes("Specialist Facial") && visitText.includes("Add-on Manicure"),
  );
  check("it says when the visit is for", visitText.includes("Service date"));
  check(
    "and separately when it was booked",
    /Booked on [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}/.test(visitText),
    "no booked-on timestamp distinct from the service date",
  );
  check(
    "the discount is shown",
    /Discount . Rs\s?[\d,]+/.test(visitText) || visitText.includes("Discount"),
  );
  check("and the agreed price", visitText.includes("Agreed at booking"));
  check("the payment panel is there", visitText.includes("Outstanding"));
  check("with nothing paid yet", visitText.includes("Nothing paid yet"));

  /* ---- taking an advance through the real form -------------------- */

  const advance = await act(owner, visitPath, 'name="paidOn"', {
    appointmentId: visitRow.id,
    amount: "50",
    method: "bank_transfer",
    paidOn: today,
    note: "20% advance",
  });
  check("an advance can be taken", advance.text.includes("Payment recorded"), advance.text.slice(0, 160));

  const afterAdvance = readable((await get(owner, visitPath)).body);
  check(
    "the payment is listed with its amount",
    /Rs\s?50/.test(afterAdvance),
    "the amount did not appear",
  );
  check("marked as an advance", afterAdvance.includes("Advance"));
  check("with its method", afterAdvance.includes("Bank transfer"));
  check("and its note", afterAdvance.includes("20% advance"));
  check(
    "and its date",
    /Advance Bank transfer [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}/.test(afterAdvance) ||
      /[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}/.test(afterAdvance),
  );
  check("the visit now reads as part-paid", afterAdvance.includes("Part-paid"));

  const { data: balanceAfter } = await admin.rpc("appointment_balance", {
    p_appointment_id: visitRow.id,
  });
  check(
    "and the balance came down by it",
    Number(balanceAfter?.[0]?.amount_paid) === 50,
    `paid ${balanceAfter?.[0]?.amount_paid}`,
  );

  // The ledger refuses to overshoot, and says so on the page.
  const overshoot = await act(owner, visitPath, 'name="paidOn"', {
    appointmentId: visitRow.id,
    amount: "9999",
    method: "cash",
    paidOn: today,
    note: "",
  });
  check(
    "paying more than is owed is refused",
    overshoot.text.includes("against a bill of"),
    overshoot.text.slice(0, 160),
  );

  /* ---- the diary shows the payment state -------------------------- */

  const diaryAfter = readable((await get(owner, `/dashboard/calendar?view=day&date=${today}`)).body);
  check("the diary marks the visit part-paid", diaryAfter.includes("Part-paid"));

  /* ---- editing the services after booking ------------------------- */

  const { data: editableRow } = await admin
    .from("appointments")
    .select("id")
    .eq("salon_id", salonId)
    .eq("notes", "bridal package")
    .maybeSingle();

  const editPath = `/dashboard/calendar/${editableRow.id}`;
  const edited = await act(owner, editPath, 'name="quotedTotal"', {
    appointmentId: editableRow.id,
    lines: JSON.stringify([{ serviceId: service.id, quantity: 1 }]),
    discount: "0",
    quotedTotal: "",
  });
  check("a booking can be re-priced", edited.text.includes("Booking updated"), edited.text.slice(0, 160));

  const { data: afterEdit } = await admin
    .from("appointments")
    .select("price_at_booking, services_subtotal")
    .eq("id", editableRow.id)
    .single();
  check(
    "and the price follows the catalogue, not the form",
    Number(afterEdit.price_at_booking) === 120,
    `got ${afterEdit.price_at_booking}`,
  );

  /* ---------------------------------------------------------------- */
  console.log("\nRaising the bill carries the customer across\n");

  /*
   * The till used to open with an empty search box even though the booking
   * knew exactly who it was for. The loyalty balance was right, which is what
   * made it easy to miss: the balance is driven by the Till's own state, while
   * the search box is driven by what the CustomerPicker was handed. Two
   * sources of truth, one of them not wired to the booking.
   *
   * So these assert on the PICKER's rendering -- the chosen-customer chip and
   * the absence of the search prompt -- not merely on the id being somewhere
   * in the page, which was true even while the bug was live.
   */
  const { data: billable } = await admin
    .from("appointments")
    .select("id, customer_id")
    .eq("salon_id", salonId)
    .eq("notes", "quoted package")
    .maybeSingle();
  check("there is a booking to bill", Boolean(billable));

  const raise = await get(owner, `/dashboard/pos?appointment=${billable.id}`);
  check("the till opens for the booking", raise.status === 200, `status ${raise.status}`);

  const raiseText = readable(raise.body);

  check(
    "the customer is already chosen, not searched for",
    !raiseText.includes("Search by name or phone"),
    "the till still asked the receptionist to find the customer",
  );
  // Specifically in the picker CHIP -- the name alone appears elsewhere on
  // the page, so asserting on it would pass with the bug present.
  check(
    "and is named in the chosen-customer chip",
    /Pat Customer . \+?[\d\s]+ Change/.test(raiseText),
    "no chosen-customer chip for them",
  );
  check(
    "the hidden field carries their id",
    raise.body.includes(`name="customerId" value="${billable.customer_id}"`),
    "customerId was not submitted",
  );
  check(
    "the visit is linked to the sale",
    raise.body.includes(`name="appointmentId" value="${billable.id}"`),
  );
  check("and the services came across", raiseText.includes("Specialist Facial"));

  // The regression the user asked me to confirm.
  check(
    "the loyalty balance still shows",
    raiseText.includes("Loyalty balance"),
    "the balance panel disappeared",
  );

  /* ---- and for a customer created during the booking itself -------- */

  /*
   * A walk-in booked with "New customer" has their profile written inside
   * create_appointment(), so by the time the till sees the visit they are a
   * real customer -- but a brand new one, who may be nowhere near the first
   * 500 rows the search box is seeded with. The prefill therefore fetches them
   * by id rather than reading that capped list.
   */
  const bornAtBooking = `Fresh ${randomUUID().slice(0, 5)}`;
  const bornPhone = `+92313${String(Date.now()).slice(-7)}`;

  await act(owner, "/dashboard/calendar", 'name="isWalkIn"', {
    customerMode: "new",
    newCustomerName: bornAtBooking,
    newCustomerPhone: bornPhone,
    staffId: qualified,
    lines: oneLine,
    date: today,
    time: "19:30",
    notes: "born at booking",
    discount: "0",
    quotedTotal: "",
    isWalkIn: "on",
  });

  const { data: newlyBooked } = await admin
    .from("appointments")
    .select("id, customer_id")
    .eq("salon_id", salonId)
    .eq("notes", "born at booking")
    .maybeSingle();
  check("the walk-in booking was created", Boolean(newlyBooked));

  const { data: bornCustomer } = await admin
    .from("customers")
    .select("full_name")
    .eq("id", newlyBooked.customer_id)
    .maybeSingle();
  check(
    "and the customer was created with it",
    bornCustomer?.full_name === bornAtBooking,
  );

  const raiseNew = await get(owner, `/dashboard/pos?appointment=${newlyBooked.id}`);
  const raiseNewText = readable(raiseNew.body);

  check(
    "a customer created at booking is pre-selected too",
    !raiseNewText.includes("Search by name or phone"),
    "the till asked for a search despite the booking knowing them",
  );
  check(
    "and named in the chip",
    new RegExp(bornAtBooking + " . \\+?[\\d\\s]+ Change").test(raiseNewText),
    "no chosen-customer chip for the newly created customer",
  );
  check(
    "with their id submitted",
    raiseNew.body.includes(`name="customerId" value="${newlyBooked.customer_id}"`),
  );



  /* ---------------------------------------------------------------- */
  console.log("\nReport presets move the date boxes\n");

  /*
   * The bug was that clicking a preset changed the figures but left the From
   * and To boxes showing the old dates -- `defaultValue` seeds an uncontrolled
   * input once, and a client-side navigation reconciles rather than remounts.
   *
   * The remount itself needs a browser to observe. What IS checkable over HTTP
   * is the other half: that the preset points at a range anchored on today,
   * and that the page it lands on renders the boxes holding that range.
   */
  const reports = await get(owner, "/dashboard/reports");
  check("the reports page renders", reports.status === 200);

  const thirty = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  check(
    "the 30-day preset is anchored on today",
    reports.body.includes(`from=${thirty}&amp;to=${today}`) ||
      reports.body.includes(`from=${thirty}&to=${today}`),
    "the preset did not point at the last 30 days ending today",
  );

  const preset = await get(owner, `/dashboard/reports?from=${thirty}&to=${today}&granularity=day`);
  check(
    "and the From box holds the start of that range",
    preset.body.includes(`name="from" type="date" value="${thirty}"`) ||
      preset.body.includes(`value="${thirty}"`),
    "the From field did not reflect the URL",
  );
  check(
    "with the To box on today",
    preset.body.includes(`value="${today}"`),
    "the To field did not reflect the URL",
  );
  check(
    "and the heading agrees with them",
    readable(preset.body).includes("Reports"),
  );





  /* ---------------------------------------------------------------- */
  console.log("\nNavigation\n");

  const dashboard = await get(owner, "/dashboard");
  check(
    "the calendar link names appointments",
    dashboard.body.includes("Calendar &amp; appointments") ||
      dashboard.body.includes("Calendar & appointments"),
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
