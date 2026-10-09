/**
 * Money arithmetic: receipts and loyalty.
 *
 * The brief is emphatic that all loyalty and payroll maths is server-side and
 * that no client total is ever trusted. This exercises the real checkout path
 * -- the create_receipt() and void_receipt() functions, called over the public
 * API as a signed-in receptionist or owner -- and checks the figures that come
 * back, the ledger behind them, and every way of trying to bend them.
 *
 *   npm run test:money
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

/** Compare money without tripping over string/number or trailing zeros. */
function money(value) {
  return Number(value).toFixed(2);
}

function eqMoney(name, actual, expected, detail = "") {
  check(
    `${name} (${money(expected)})`,
    money(actual) === money(expected),
    detail || `got ${money(actual)}`,
  );
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
    const { error } = await admin
      .from("invitations")
      .insert({ salon_id: salonId, email, role });
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
          salon_name: `Money Salon ${randomUUID().slice(0, 4)}`,
          business_type: "salon",
          country: "US",
          timezone: "UTC",
          currency: "USD",
        },
  });
  if (error) throw new Error(`create ${label}: ${error.message}`);

  createdUserIds.push(data.user.id);

  /*
   * Two identities, since the Team/User split. `userId` is the login -- who
   * takes an action. `memberId` is the roster entry -- who performs services
   * and gets paid. handle_new_user() creates the second and links it.
   */
  const { data: profile } = await admin
    .from("profiles")
    .select("team_member_id")
    .eq("id", data.user.id)
    .single();

  return { email, userId: data.user.id, memberId: profile.team_member_id };
}

async function buildSalon() {
  const owner = await makeUser(null, "owner", "owner");
  const { data: profile } = await admin
    .from("profiles")
    .select("salon_id")
    .eq("id", owner.userId)
    .single();
  const salonId = profile.salon_id;
  createdSalonIds.push(salonId);

  const receptionist = await makeUser(salonId, "receptionist", "reception");
  const therapist = await makeUser(salonId, "staff", "therapist");

  async function service(name, price, minutes = 30) {
    const { data, error } = await admin
      .from("services")
      .insert({ salon_id: salonId, name, price, duration_minutes: minutes })
      .select("id")
      .single();
    if (error) throw new Error(`service ${name}: ${error.message}`);
    return data.id;
  }

  const cut = await service("Cut", 40.0);
  const colour = await service("Colour", 60.0);
  const odd = await service("Odd Price", 33.33);

  const { data: customer, error: customerError } = await admin
    .from("customers")
    .insert({ salon_id: salonId, full_name: "Pat Customer", phone: `+1555${Date.now() % 10000000}` })
    .select("id")
    .single();
  if (customerError) throw new Error(`customer: ${customerError.message}`);

  return { salonId, owner, receptionist, therapist, cut, colour, odd, customerId: customer.id };
}

async function makeDeal(salonId, name, type, value, serviceIds) {
  const { data, error } = await admin
    .from("deals")
    .insert({
      salon_id: salonId,
      name,
      deal_type: type,
      value,
      starts_on: "2020-01-01",
      ends_on: "2099-12-31",
    })
    .select("id")
    .single();
  if (error) throw new Error(`deal ${name}: ${error.message}`);

  const { error: linkError } = await admin
    .from("deal_services")
    .insert(serviceIds.map((id) => ({ salon_id: salonId, deal_id: data.id, service_id: id })));
  if (linkError) throw new Error(`deal_services: ${linkError.message}`);

  return data.id;
}

async function cleanup() {
  // Deleting the salon cascades to its customers, receipts and loyalty ledger.
  for (const id of createdSalonIds) {
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

/** Read a receipt back with the service-role client, bypassing RLS. */
async function readReceipt(id) {
  if (!id) throw new Error("readReceipt called without an id -- the checkout above failed");
  const { data } = await admin.from("receipts").select("*").eq("id", id).single();
  const { data: lines } = await admin
    .from("receipt_line_items")
    .select("*")
    .eq("receipt_id", id)
    .order("sort_order");
  return { ...data, lines: lines ?? [] };
}

async function balanceOf(admin_, customerId) {
  const { data } = await admin_
    .from("loyalty_transactions")
    .select("amount")
    .eq("customer_id", customerId);
  return (data ?? []).reduce((sum, r) => sum + Number(r.amount), 0);
}

async function main() {
  console.log("\nSetting up a salon\n");
  const s = await buildSalon();
  const desk = await clientFor(s.receptionist.email);
  const ownerClient = await clientFor(s.owner.email);
  const staffClient = await clientFor(s.therapist.email);
  check("salon, team, services and customer created", true);

  const line = (serviceId, quantity = 1) => ({
    service_id: serviceId,
    staff_id: s.therapist.memberId,
    quantity,
  });

  async function checkout(overrides = {}) {
    const body = {
      p_customer_id: s.customerId,
      p_payment_method: "cash",
      p_cash_amount: 0,
      p_card_amount: 0,
      p_loyalty_redeem: 0,
      p_deal_id: null,
      p_notes: "",
      p_lines: [line(s.cut)],
      ...overrides,
    };
    return desk.rpc("create_receipt", body);
  }

  /* ---------------------------------------------------------------- */
  console.log("\nA plain sale\n");

  const { data: id1, error: err1 } = await checkout({
    p_lines: [line(s.cut), line(s.colour)],
  });
  check("a receipt can be issued", !err1, err1?.message);

  const r1 = await readReceipt(id1);
  eqMoney("subtotal is the sum of catalogue prices", r1.subtotal, 100);
  eqMoney("no discount", r1.discount_total, 0);
  eqMoney("total matches", r1.total, 100);
  eqMoney("earns 5% of the total", r1.loyalty_earned, 5);
  check("the rate used is recorded on the receipt", Number(r1.loyalty_earn_rate) === 0.05);
  check("receipt numbering starts at 1", r1.receipt_number === 1);
  check("two line items", r1.lines.length === 2);
  check(
    "each line is attributed to the therapist who performed it",
    r1.lines.every((l) => l.staff_id === s.therapist.memberId),
  );
  check(
    "the service name is snapshotted onto the line",
    r1.lines.some((l) => l.service_name === "Cut"),
  );
  eqMoney("cash covers the whole total", r1.cash_amount, 100);

  const balance1 = await balanceOf(admin, s.customerId);
  eqMoney("the balance is the earned amount", balance1, 5);

  /* ---------------------------------------------------------------- */
  console.log("\nPrices come from the catalogue, not the caller\n");

  // There is no price parameter at all, so the only way to try is to write the
  // tables directly -- which has no policy permitting it.
  const { error: forgedReceipt } = await desk.from("receipts").insert({
    salon_id: s.salonId,
    receipt_number: 9999,
    customer_id: s.customerId,
    subtotal: 1,
    total: 1,
    loyalty_earn_rate: 0.05,
    payment_method: "cash",
    cash_amount: 1,
  });
  check("a receipt cannot be inserted directly", Boolean(forgedReceipt));

  const { error: forgedLine } = await desk.from("receipt_line_items").insert({
    salon_id: s.salonId,
    receipt_id: id1,
    service_name: "Freebie",
    unit_price: 0,
    line_total: 0,
  });
  check("a receipt line cannot be inserted directly", Boolean(forgedLine));

  const { error: forgedLoyalty } = await desk.from("loyalty_transactions").insert({
    salon_id: s.salonId,
    customer_id: s.customerId,
    type: "earn",
    amount: 1000,
    resulting_balance: 1000,
  });
  check("loyalty cannot be minted directly", Boolean(forgedLoyalty));

  const { error: editedReceipt } = await desk
    .from("receipts")
    .update({ total: 1 })
    .eq("id", id1)
    .select();
  const stillR1 = await readReceipt(id1);
  check(
    "a receipt cannot be edited",
    money(stillR1.total) === "100.00",
    editedReceipt?.message?.slice(0, 60),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nRedeeming loyalty\n");

  const { error: overBalance } = await checkout({
    p_lines: [line(s.cut)],
    p_loyalty_redeem: 50,
  });
  check("cannot redeem more than the balance", Boolean(overBalance), overBalance?.message?.slice(0, 70));

  const { data: id2, error: err2 } = await checkout({
    p_lines: [line(s.cut)],
    p_loyalty_redeem: 5,
  });
  check("can redeem the available balance", !err2, err2?.message);

  const r2 = await readReceipt(id2);
  eqMoney("subtotal untouched by redemption", r2.subtotal, 40);
  eqMoney("redemption recorded", r2.loyalty_redeemed, 5);
  eqMoney("total is reduced by the redemption", r2.total, 35);
  eqMoney("earning is on what was actually paid", r2.loyalty_earned, 1.75);

  const balance2 = await balanceOf(admin, s.customerId);
  eqMoney("balance = 5 earned - 5 redeemed + 1.75 earned", balance2, 1.75);

  const { data: ledger } = await admin
    .from("loyalty_transactions")
    .select("type, amount, resulting_balance, created_at")
    .eq("customer_id", s.customerId)
    .order("created_at");
  check("every movement is in the ledger", (ledger ?? []).length === 3);
  eqMoney(
    "the last resulting_balance agrees with the sum",
    ledger[ledger.length - 1].resulting_balance,
    balance2,
  );

  // Points earned on a bill must not be spendable within that same bill.
  const balanceBefore = await balanceOf(admin, s.customerId);
  const { error: sameTxn } = await checkout({
    p_lines: [line(s.colour)],
    p_loyalty_redeem: balanceBefore + 3,
  });
  check(
    "points earned on a bill cannot be spent on that same bill",
    Boolean(sameTxn),
    sameTxn?.message?.slice(0, 70),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nRedemption is capped by the bill, not just the balance\n");

  // Build a balance comfortably larger than the next bill, so the cap being
  // exercised below is the bill, not the balance.
  await checkout({ p_lines: [line(s.colour, 20)] }); // 1200 -> earns 60
  const bigBalance = await balanceOf(admin, s.customerId);
  check(
    "balance now exceeds the price of a cut",
    bigBalance > 40,
    `balance ${money(bigBalance)}`,
  );

  const { error: overBill } = await checkout({
    p_lines: [line(s.cut)],
    p_loyalty_redeem: 40.01,
  });
  check("cannot redeem more than the bill", Boolean(overBill), overBill?.message?.slice(0, 70));

  const { data: idFull, error: fullError } = await checkout({
    p_lines: [line(s.cut)],
    p_loyalty_redeem: 40,
  });
  check("a bill can be settled entirely with loyalty", !fullError, fullError?.message);
  const rFull = await readReceipt(idFull);
  eqMoney("a fully redeemed bill costs nothing", rFull.total, 0);
  eqMoney("and earns nothing", rFull.loyalty_earned, 0);
  eqMoney("cash taken is zero", rFull.cash_amount, 0);

  /* ---------------------------------------------------------------- */
  console.log("\nRounding\n");

  const { data: idOdd } = await checkout({ p_lines: [line(s.odd)] });
  const rOdd = await readReceipt(idOdd);
  eqMoney("an awkward price is kept exactly", rOdd.subtotal, 33.33);
  // 5% of 33.33 = 1.6665, which must land on 1.67, not 1.66 and not 1.6665.
  eqMoney("5% of 33.33 rounds to two places", rOdd.loyalty_earned, 1.67);

  const { data: idOdd3 } = await checkout({ p_lines: [line(s.odd, 3)] });
  const rOdd3 = await readReceipt(idOdd3);
  eqMoney("quantity multiplies exactly", rOdd3.subtotal, 99.99);
  eqMoney("and its earning rounds once, at the end", rOdd3.loyalty_earned, 5.0);

  /* ---------------------------------------------------------------- */
  console.log("\nDeals\n");

  const pctDeal = await makeDeal(s.salonId, "20% off cuts", "percentage", 20, [s.cut]);
  const { data: idPct } = await checkout({
    p_lines: [line(s.cut), line(s.colour)],
    p_deal_id: pctDeal,
  });
  const rPct = await readReceipt(idPct);
  eqMoney("percentage deal discounts only eligible lines", rPct.discount_total, 8);
  eqMoney("total reflects the discount", rPct.total, 92);
  const cutLine = rPct.lines.find((l) => l.service_name === "Cut");
  const colourLine = rPct.lines.find((l) => l.service_name === "Colour");
  eqMoney("the discount lands on the eligible line", cutLine.discount_amount, 8);
  eqMoney("and not on the others", colourLine.discount_amount, 0);
  eqMoney("line totals net the discount", cutLine.line_total, 32);

  const fixedDeal = await makeDeal(s.salonId, "10 off colour", "fixed_amount", 10, [s.colour]);
  const { data: idFixed } = await checkout({
    p_lines: [line(s.colour)],
    p_deal_id: fixedDeal,
  });
  const rFixed = await readReceipt(idFixed);
  eqMoney("fixed-amount deal", rFixed.discount_total, 10);
  eqMoney("total", rFixed.total, 50);

  // A fixed discount must never exceed what is being discounted.
  const bigFixed = await makeDeal(s.salonId, "500 off cuts", "fixed_amount", 500, [s.cut]);
  const { data: idCapped } = await checkout({ p_lines: [line(s.cut)], p_deal_id: bigFixed });
  const rCapped = await readReceipt(idCapped);
  eqMoney("a fixed discount is capped at the line value", rCapped.discount_total, 40);
  eqMoney("so the bill never goes negative", rCapped.total, 0);

  const bundle = await makeDeal(s.salonId, "Cut + colour bundle", "bundle_price", 80, [
    s.cut,
    s.colour,
  ]);
  const { error: partialBundle } = await checkout({
    p_lines: [line(s.cut)],
    p_deal_id: bundle,
  });
  check(
    "a bundle needs all of its services present",
    Boolean(partialBundle),
    partialBundle?.message?.slice(0, 70),
  );

  const { data: idBundle } = await checkout({
    p_lines: [line(s.cut), line(s.colour)],
    p_deal_id: bundle,
  });
  const rBundle = await readReceipt(idBundle);
  eqMoney("a bundle charges the bundle price", rBundle.total, 80);
  eqMoney("recorded as a discount of the difference", rBundle.discount_total, 20);
  const allocated = rBundle.lines.reduce((sum, l) => sum + Number(l.discount_amount), 0);
  eqMoney("the allocation across lines adds up exactly", allocated, rBundle.discount_total);
  check(
    "each line still nets out correctly",
    rBundle.lines.every(
      (l) => money(l.line_total) === money(Number(l.unit_price) * l.quantity - Number(l.discount_amount)),
    ),
  );

  // Three-way proportional split is where rounding drift shows up.
  const oddBundle = await makeDeal(s.salonId, "Odd trio", "bundle_price", 100, [
    s.cut,
    s.colour,
    s.odd,
  ]);
  const { data: idTrio } = await checkout({
    p_lines: [line(s.cut), line(s.colour), line(s.odd)],
    p_deal_id: oddBundle,
  });
  const rTrio = await readReceipt(idTrio);
  eqMoney("an awkward bundle still charges exactly the bundle price", rTrio.total, 100);
  const trioAllocated = rTrio.lines.reduce((sum, l) => sum + Number(l.discount_amount), 0);
  eqMoney("and its allocation still adds up to the cent", trioAllocated, rTrio.discount_total);

  /* ---------------------------------------------------------------- */
  console.log("\nPayment\n");

  const { error: badSplit } = await checkout({
    p_lines: [line(s.cut)],
    p_payment_method: "split",
    p_cash_amount: 10,
    p_card_amount: 10,
  });
  check("a split that does not add up is refused", Boolean(badSplit), badSplit?.message?.slice(0, 70));

  const { data: idSplit } = await checkout({
    p_lines: [line(s.cut)],
    p_payment_method: "split",
    p_cash_amount: 15,
    p_card_amount: 25,
  });
  const rSplit = await readReceipt(idSplit);
  eqMoney("a valid split is recorded, cash side", rSplit.cash_amount, 15);
  eqMoney("and card side", rSplit.card_amount, 25);

  /* ---------------------------------------------------------------- */
  console.log("\nBank transfer\n");

  /*
   * A transfer is neither cash nor card, so it has its own column rather than
   * riding in cash_amount -- which would keep the arithmetic working while
   * making the receipt say something false about how the money arrived.
   */
  const wired = await desk.rpc("create_receipt", {
    p_customer_id: s.customerId,
    p_payment_method: "bank_transfer",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [{ service_id: s.cut, staff_id: s.therapist.memberId, quantity: 1 }],
  });
  check("a bill can be settled by transfer", !wired.error, wired.error?.message);

  const wiredReceipt = await readReceipt(wired.data);
  eqMoney("the whole bill lands in the transfer column", wiredReceipt.transfer_amount, 40);
  eqMoney("and none of it in cash", wiredReceipt.cash_amount, 0);
  eqMoney("or card", wiredReceipt.card_amount, 0);
  check("the method is recorded as the transfer it was",
    wiredReceipt.payment_method === "bank_transfer");

  const { data: wiredLedger } = await admin
    .from("payments")
    .select("method, amount")
    .eq("receipt_id", wired.data);
  check(
    "the ledger records it as a transfer, not as cash",
    (wiredLedger ?? []).length === 1 && wiredLedger[0].method === "bank_transfer",
    `got ${JSON.stringify(wiredLedger)}`,
  );

  /* ---- a split may now use all three ------------------------------ */

  const threeWay = await desk.rpc("create_receipt", {
    p_customer_id: s.customerId,
    p_payment_method: "split",
    p_cash_amount: 10,
    p_card_amount: 20,
    p_transfer_amount: 10,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [{ service_id: s.cut, staff_id: s.therapist.memberId, quantity: 1 }],
  });
  check("a three-way split is accepted", !threeWay.error, threeWay.error?.message);

  const threeWayReceipt = await readReceipt(threeWay.data);
  eqMoney("the cash part is kept", threeWayReceipt.cash_amount, 10);
  eqMoney("the card part too", threeWayReceipt.card_amount, 20);
  eqMoney("and the transferred part", threeWayReceipt.transfer_amount, 10);

  const { data: threeWayLedger } = await admin
    .from("payments")
    .select("method, amount")
    .eq("receipt_id", threeWay.data)
    .order("method");
  check(
    "each part is its own ledger entry",
    (threeWayLedger ?? []).length === 3,
    `got ${(threeWayLedger ?? []).length}`,
  );
  check(
    "one of them a transfer",
    (threeWayLedger ?? []).some((p) => p.method === "bank_transfer"),
  );

  const shortSplit = await desk.rpc("create_receipt", {
    p_customer_id: s.customerId,
    p_payment_method: "split",
    p_cash_amount: 10,
    p_card_amount: 10,
    p_transfer_amount: 10,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [{ service_id: s.cut, staff_id: s.therapist.memberId, quantity: 1 }],
  });
  check(
    "a three-way split that does not add up is refused",
    Boolean(shortSplit.error),
    shortSplit.error?.message?.slice(0, 90),
  );

  // The Phase 4 invariant, with its third term: a receipt still states its own
  // settlement exactly.
  check(
    "cash + card + transfer + deposit still equals the total, on every receipt",
    [wiredReceipt, threeWayReceipt].every(
      (r) =>
        Math.abs(
          Number(r.cash_amount) +
            Number(r.card_amount) +
            Number(r.transfer_amount) +
            Number(r.deposit_applied) -
            Number(r.total),
        ) < 0.005,
    ),
  );



  /* ---------------------------------------------------------------- */
  console.log("\nA receipt needs a therapist on every line\n");

  const { error: noStaff } = await desk.rpc("create_receipt", {
    p_customer_id: s.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [{ service_id: s.cut, quantity: 1 }],
  });
  check("an unattributed line is refused", Boolean(noStaff), noStaff?.message?.slice(0, 70));

  /*
   * This used to assert that a receptionist could not be credited with
   * performing a service, because "may perform" was inferred from a role on a
   * LOGIN. That inference is gone: being on the roster is the statement now,
   * and a receptionist who also does nails simply has a roster entry.
   *
   * What replaces it is the guarantee that actually holds -- a line must name
   * an active member of THIS salon's roster.
   */
  const { error: strangerPerformed } = await checkout({
    p_lines: [{ service_id: s.cut, staff_id: randomUUID(), quantity: 1 }],
  });
  check(
    "a line naming nobody on the roster is refused",
    Boolean(strangerPerformed),
    strangerPerformed?.message?.slice(0, 70),
  );

  // Someone who has left cannot be credited with new work.
  const departed = await makeUser(s.salonId, "staff", "departed");
  await admin
    .from("team_members")
    .update({ is_active: false })
    .eq("id", departed.memberId);

  const { error: departedPerformed } = await checkout({
    p_lines: [{ service_id: s.cut, staff_id: departed.memberId, quantity: 1 }],
  });
  check(
    "nor one naming someone no longer active",
    Boolean(departedPerformed),
    departedPerformed?.message?.slice(0, 70),
  );

  const { error: emptyReceipt } = await checkout({ p_lines: [] });
  check("an empty receipt is refused", Boolean(emptyReceipt));

  /* ---------------------------------------------------------------- */
  console.log("\nWho may do what\n");

  const { error: staffCheckout } = await staffClient.rpc("create_receipt", {
    p_customer_id: s.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [line(s.cut)],
  });
  check("a therapist cannot take payment", Boolean(staffCheckout), staffCheckout?.message?.slice(0, 70));

  const { data: staffSeesReceipts } = await staffClient.from("receipts").select("id");
  check("a therapist cannot read receipts", (staffSeesReceipts ?? []).length === 0);

  const { data: staffSeesLines } = await staffClient.from("receipt_line_items").select("id, staff_id");
  check(
    "but can see the lines they performed",
    (staffSeesLines ?? []).length > 0 &&
      staffSeesLines.every((l) => l.staff_id === s.therapist.memberId),
  );

  const { data: staffSeesLoyalty } = await staffClient.from("loyalty_transactions").select("id");
  check("a therapist cannot read the loyalty ledger", (staffSeesLoyalty ?? []).length === 0);

  /* ---------------------------------------------------------------- */
  console.log("\nVoiding\n");

  const { error: deskVoid } = await desk.rpc("void_receipt", {
    p_receipt_id: id1,
    p_reason: "mistake",
  });
  check("a receptionist cannot void", Boolean(deskVoid), deskVoid?.message?.slice(0, 70));

  const { error: noReason } = await ownerClient.rpc("void_receipt", {
    p_receipt_id: id1,
    p_reason: "",
  });
  check("voiding without a reason is refused", Boolean(noReason), noReason?.message?.slice(0, 70));

  const balanceBeforeVoid = await balanceOf(admin, s.customerId);
  const r2Before = await readReceipt(id2);

  const { error: voided } = await ownerClient.rpc("void_receipt", {
    p_receipt_id: id2,
    p_reason: "Charged the wrong customer",
  });
  check("an owner can void with a reason", !voided, voided?.message);

  const r2After = await readReceipt(id2);
  check("the receipt survives, marked voided", r2After.status === "voided");
  check("the reason is kept", r2After.void_reason === "Charged the wrong customer");
  check("and who voided it", r2After.voided_by === s.owner.userId);
  eqMoney("the original figures are untouched", r2After.total, r2Before.total);

  const balanceAfterVoid = await balanceOf(admin, s.customerId);
  eqMoney(
    "voiding reverses what the receipt earned and restores what it redeemed",
    balanceAfterVoid,
    balanceBeforeVoid - Number(r2Before.loyalty_earned) + Number(r2Before.loyalty_redeemed),
  );

  const { data: reversals } = await admin
    .from("loyalty_transactions")
    .select("type")
    .eq("receipt_id", id2)
    .eq("type", "void_reversal");
  check("the reversal is recorded in the ledger, not by editing it", (reversals ?? []).length === 2);

  const { error: doubleVoid } = await ownerClient.rpc("void_receipt", {
    p_receipt_id: id2,
    p_reason: "again",
  });
  check("a receipt cannot be voided twice", Boolean(doubleVoid), doubleVoid?.message?.slice(0, 70));

  const { error: reinstate } = await ownerClient
    .from("receipts")
    .update({ status: "issued" })
    .eq("id", id2)
    .select();
  const r2Final = await readReceipt(id2);
  check(
    "a voided receipt cannot be reinstated",
    r2Final.status === "voided",
    reinstate?.message?.slice(0, 60),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nThe ledger is append-only\n");

  const { data: anyTxn } = await admin
    .from("loyalty_transactions")
    .select("id")
    .eq("customer_id", s.customerId)
    .limit(1)
    .single();

  const { error: editLedger } = await ownerClient
    .from("loyalty_transactions")
    .update({ amount: 999 })
    .eq("id", anyTxn.id)
    .select();
  const { data: ledgerRow } = await admin
    .from("loyalty_transactions")
    .select("amount")
    .eq("id", anyTxn.id)
    .single();
  check(
    "a ledger entry cannot be edited",
    money(ledgerRow.amount) !== "999.00",
    editLedger?.message?.slice(0, 60),
  );

  const { error: deleteLedger } = await ownerClient
    .from("loyalty_transactions")
    .delete()
    .eq("id", anyTxn.id)
    .select();
  const { data: ledgerStill } = await admin
    .from("loyalty_transactions")
    .select("id")
    .eq("id", anyTxn.id)
    .maybeSingle();
  check(
    "and cannot be deleted",
    Boolean(ledgerStill),
    deleteLedger?.message?.slice(0, 60),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nThe earn rate is configurable, not hardcoded\n");

  await admin
    .from("salon_settings")
    .update({ loyalty_earn_rate: 0.1 })
    .eq("salon_id", s.salonId);

  const { data: idTen } = await checkout({ p_lines: [line(s.cut)] });
  const rTen = await readReceipt(idTen);
  eqMoney("a 10% rate earns 10%", rTen.loyalty_earned, 4);
  check("and the receipt records the rate it used", Number(rTen.loyalty_earn_rate) === 0.1);

  await admin
    .from("salon_settings")
    .update({ loyalty_earn_rate: 0 })
    .eq("salon_id", s.salonId);
  const { data: idZero } = await checkout({ p_lines: [line(s.cut)] });
  const rZero = await readReceipt(idZero);
  eqMoney("a zero rate earns nothing", rZero.loyalty_earned, 0);

  /* ---------------------------------------------------------------- */
  console.log("\nDeposits: money taken before there is a receipt\n");

  /*
   * The case the whole ledger exists for: "20% today, 20% on Thursday, the
   * rest on the day". The first two payments happen before any receipt, so
   * there is nothing yet to hang a paid/unpaid column on.
   */
  async function book(staffId, serviceIds, when, quoted = null) {
    const { data, error } = await desk.rpc("create_appointment", {
      p_customer_id: s.customerId,
      p_new_customer_name: null,
      p_new_customer_phone: null,
      p_staff_id: staffId,
      p_starts_at: when,
      p_notes: "",
      p_is_walk_in: true,
      p_discount: 0,
      p_quoted_total: quoted,
      p_lines: serviceIds.map((id) => ({ service_id: id, quantity: 1 })),
    });
    if (error) throw new Error(`booking: ${error.message}`);
    return data;
  }

  async function balanceOfAppointment(id) {
    const { data } = await admin.rpc("appointment_balance", { p_appointment_id: id });
    return data?.[0];
  }

  const slot = (hour) => {
    const d = new Date();
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  // Cut (40) + Colour (60) = 100 agreed.
  const visit = await book(s.therapist.memberId, [s.cut, s.colour], slot(6));

  const fresh = await balanceOfAppointment(visit);
  eqMoney("a new booking owes the agreed price", fresh?.amount_due, 100);
  eqMoney("and has had nothing paid", fresh?.amount_paid, 0);
  check("with no receipt against it", fresh?.has_receipt === false);

  const { error: depositError } = await desk.rpc("record_payment", {
    p_appointment_id: visit,
    p_amount: 20,
    p_method: "cash",
    p_paid_at: null,
    p_note: "20% advance",
  });
  check("the front desk can take an advance", !depositError, depositError?.message);

  let state = await balanceOfAppointment(visit);
  eqMoney("the advance is on the visit", state?.amount_paid, 20);
  eqMoney("and the balance drops by it", state?.balance, 80);

  // A second instalment, dated earlier -- money does not always reach the
  // system on the day it changed hands.
  await desk.rpc("record_payment", {
    p_appointment_id: visit,
    p_amount: 20,
    p_method: "bank_transfer",
    p_paid_at: new Date(Date.now() - 3 * 86400000).toISOString(),
    p_note: "second instalment",
  });

  state = await balanceOfAppointment(visit);
  eqMoney("two instalments add up", state?.amount_paid, 40);
  eqMoney("leaving the remainder", state?.balance, 60);

  const { data: advanceLedger } = await admin
    .from("payments")
    .select("*")
    .eq("appointment_id", visit)
    .order("paid_at");
  check("both are recorded as advances", (advanceLedger ?? []).every((p) => p.kind === "deposit"));
  check("each keeping its own method", (advanceLedger ?? []).map((p) => p.method).includes("bank_transfer"));
  check(
    "and its own date",
    new Date(advanceLedger[0].paid_at).getTime() < new Date(advanceLedger[1].paid_at).getTime(),
    "the back-dated instalment did not sort first",
  );

  /* ---- what a deposit may not do ---------------------------------- */

  const { error: tooMuch } = await desk.rpc("record_payment", {
    p_appointment_id: visit,
    p_amount: 100,
    p_method: "cash",
    p_paid_at: null,
    p_note: "",
  });
  check(
    "a payment past the bill is refused",
    Boolean(tooMuch),
    tooMuch?.message?.slice(0, 80),
  );

  state = await balanceOfAppointment(visit);
  eqMoney("and nothing was taken", state?.amount_paid, 40);

  const { error: negative } = await desk.rpc("record_payment", {
    p_appointment_id: visit,
    p_amount: -10,
    p_method: "cash",
    p_paid_at: null,
    p_note: "",
  });
  check("a negative payment is refused", Boolean(negative));

  const { error: staffTakes } = await staffClient.rpc("record_payment", {
    p_appointment_id: visit,
    p_amount: 5,
    p_method: "cash",
    p_paid_at: null,
    p_note: "",
  });
  check("a therapist cannot take a payment", Boolean(staffTakes));

  /* ---------------------------------------------------------------- */
  console.log("\nCheckout collects the balance, not the bill\n");

  const settled = await desk.rpc("create_receipt", {
    p_customer_id: s.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [
      { service_id: s.cut, staff_id: s.therapist.memberId, quantity: 1 },
      { service_id: s.colour, staff_id: s.therapist.memberId, quantity: 1 },
    ],
    p_appointment_id: visit,
  });
  check("the visit can be checked out", !settled.error, settled.error?.message);

  const bill = await readReceipt(settled.data);
  eqMoney("the receipt still bills the whole amount", bill.total, 100);
  check("and is linked to the visit", bill.appointment_id === visit);

  // The distinction that matters: the receipt says 100 is owed, the till only
  // took the 60 that was left.
  eqMoney("but the till collected only the balance", bill.cash_amount, 60);

  state = await balanceOfAppointment(visit);
  eqMoney("so the visit is now fully paid", state?.amount_paid, 100);
  eqMoney("with nothing outstanding", state?.balance, 0);
  check("and it has a receipt", state?.has_receipt === true);

  const { data: settlements } = await admin
    .from("payments")
    .select("*")
    .eq("receipt_id", settled.data);
  check("the collection is its own ledger entry", (settlements ?? []).length === 1);
  check("marked as taken at checkout", settlements?.[0]?.kind === "settlement");

  const twice = await desk.rpc("create_receipt", {
    p_customer_id: s.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [{ service_id: s.cut, staff_id: s.therapist.memberId, quantity: 1 }],
    p_appointment_id: visit,
  });
  check(
    "a visit cannot be billed twice",
    Boolean(twice.error),
    twice.error?.message?.slice(0, 70),
  );

  /* ---- a split pays the balance, not the total -------------------- */

  const splitVisit = await book(s.therapist.memberId, [s.cut, s.colour], slot(7));
  await desk.rpc("record_payment", {
    p_appointment_id: splitVisit,
    p_amount: 30,
    p_method: "card",
    p_paid_at: null,
    p_note: "",
  });

  const wrongSplit = await desk.rpc("create_receipt", {
    p_customer_id: s.customerId,
    p_payment_method: "split",
    p_cash_amount: 50,
    p_card_amount: 50,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [
      { service_id: s.cut, staff_id: s.therapist.memberId, quantity: 1 },
      { service_id: s.colour, staff_id: s.therapist.memberId, quantity: 1 },
    ],
    p_appointment_id: splitVisit,
  });
  check(
    "a split adding to the full bill is refused once a deposit is held",
    Boolean(wrongSplit.error),
    wrongSplit.error?.message?.slice(0, 80),
  );

  const rightSplit = await desk.rpc("create_receipt", {
    p_customer_id: s.customerId,
    p_payment_method: "split",
    p_cash_amount: 40,
    p_card_amount: 30,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [
      { service_id: s.cut, staff_id: s.therapist.memberId, quantity: 1 },
      { service_id: s.colour, staff_id: s.therapist.memberId, quantity: 1 },
    ],
    p_appointment_id: splitVisit,
  });
  check("a split adding to the balance goes through", !rightSplit.error, rightSplit.error?.message);

  const { data: splitRows } = await admin
    .from("payments")
    .select("method, amount")
    .eq("receipt_id", rightSplit.data)
    .order("method");
  check(
    "and is recorded as the two payments it was",
    (splitRows ?? []).length === 2,
    `got ${(splitRows ?? []).length}`,
  );

  /* ---------------------------------------------------------------- */
  console.log("\nCommission follows the receipt, not the quote\n");

  /*
   * The explicit requirement: if a discount is given at checkout, commission
   * reflects the discounted amount rather than the price quoted when the
   * booking was taken. Quote high, bill low, and check which one payroll sees.
   */
  const quotedHigh = await book(s.therapist.memberId, [s.cut], slot(8), 500);
  const quotedState = await balanceOfAppointment(quotedHigh);
  eqMoney("the booking is quoted well above the price list", quotedState?.amount_due, 500);

  const billedLow = await desk.rpc("create_receipt", {
    p_customer_id: s.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [{ service_id: s.cut, staff_id: s.therapist.memberId, quantity: 1 }],
    p_appointment_id: quotedHigh,
  });
  check("but bills at the price list", !billedLow.error, billedLow.error?.message);

  const lowBill = await readReceipt(billedLow.data);
  eqMoney("the receipt is the catalogue price", lowBill.total, 40);
  eqMoney(
    "and the line payroll reads is the billed amount, not the quote",
    lowBill.lines[0].line_total,
    40,
  );

  /* ---------------------------------------------------------------- */
  console.log("\nRefunds, and an append-only ledger\n");

  const refundable = await book(s.therapist.memberId, [s.cut], slot(9));
  const { data: advanceId } = await desk.rpc("record_payment", {
    p_appointment_id: refundable,
    p_amount: 25,
    p_method: "cash",
    p_paid_at: null,
    p_note: "",
  });

  const { error: deskRefunds } = await desk.rpc("refund_payment", {
    p_payment_id: advanceId,
    p_reason: "Customer cancelled",
  });
  check("a receptionist cannot refund", Boolean(deskRefunds), deskRefunds?.message?.slice(0, 60));

  const { error: noReasonVisit } = await ownerClient.rpc("refund_payment", {
    p_payment_id: advanceId,
    p_reason: "",
  });
  check("a refund without a reason is refused", Boolean(noReasonVisit));

  const { error: refundError } = await ownerClient.rpc("refund_payment", {
    p_payment_id: advanceId,
    p_reason: "Customer cancelled",
  });
  check("the owner can refund", !refundError, refundError?.message);

  const refundedState = await balanceOfAppointment(refundable);
  eqMoney("the refund nets the visit back to nothing paid", refundedState?.amount_paid, 0);

  const { data: refundRows } = await admin
    .from("payments")
    .select("*")
    .eq("appointment_id", refundable)
    .order("created_at");
  check("the original payment is still on the record", (refundRows ?? []).length === 2);
  check("with the refund beside it", refundRows?.[1]?.kind === "refund");
  check("pointing at what it reverses", refundRows?.[1]?.reverses_id === advanceId);

  const { error: twiceRefunded } = await ownerClient.rpc("refund_payment", {
    p_payment_id: advanceId,
    p_reason: "Again",
  });
  check("the same payment cannot be refunded twice", Boolean(twiceRefunded));

  // RLS does not constrain the service_role key, so the guard trigger is what
  // actually makes this ledger append-only.
  const { error: editLedgerVisit } = await admin
    .from("payments")
    .update({ amount: 9999 })
    .eq("id", advanceId);
  check(
    "not even the service key can edit a payment",
    Boolean(editLedgerVisit),
    editLedgerVisit?.message?.slice(0, 70),
  );

  const { error: deleteLedgerVisit } = await admin.from("payments").delete().eq("id", advanceId);
  check("nor delete one", Boolean(deleteLedgerVisit), deleteLedgerVisit?.message?.slice(0, 70));

  /* ---- voiding gives back what the till took, not the deposit ------ */

  const voidVisit = await book(s.therapist.memberId, [s.cut, s.colour], slot(10));
  await desk.rpc("record_payment", {
    p_appointment_id: voidVisit,
    p_amount: 25,
    p_method: "cash",
    p_paid_at: null,
    p_note: "advance",
  });
  const voidable = await desk.rpc("create_receipt", {
    p_customer_id: s.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [
      { service_id: s.cut, staff_id: s.therapist.memberId, quantity: 1 },
      { service_id: s.colour, staff_id: s.therapist.memberId, quantity: 1 },
    ],
    p_appointment_id: voidVisit,
  });
  check("a visit with an advance can be checked out", !voidable.error, voidable.error?.message);

  await ownerClient.rpc("void_receipt", {
    p_receipt_id: voidable.data,
    p_reason: "Rung up wrong",
  });

  const afterVoid = await balanceOfAppointment(voidVisit);
  // The 75 the till took is handed back; the 25 advance is still held, because
  // the salon still has it and the visit may simply be rung up again.
  eqMoney("voiding returns what the till collected", afterVoid?.amount_paid, 25);
  check("and the visit is unbilled again", afterVoid?.has_receipt === false);
  eqMoney("so the agreed price is what is owed once more", afterVoid?.amount_due, 100);

  /* ---------------------------------------------------------------- */
  console.log("\nEditing a booking after it is made\n");

  const editable = await book(s.therapist.memberId, [s.cut], slot(11));

  const { error: addService } = await desk.rpc("update_appointment_services", {
    p_appointment_id: editable,
    p_lines: [
      { service_id: s.cut, quantity: 1 },
      { service_id: s.colour, quantity: 2 },
    ],
    p_discount: 0,
    p_quoted_total: null,
  });
  check("services can be added to a booking", !addService, addService?.message);

  const { data: edited } = await admin
    .from("appointments")
    .select("services_subtotal, price_at_booking, starts_at, ends_at")
    .eq("id", editable)
    .single();
  // 40 + two 60s.
  eqMoney("the price is recalculated from the catalogue", edited?.price_at_booking, 160);
  eqMoney("and the subtotal with it", edited?.services_subtotal, 160);

  const editedMinutes =
    (new Date(edited.ends_at).getTime() - new Date(edited.starts_at).getTime()) / 60000;
  check(
    "and the slot grows to fit them",
    editedMinutes === 90,
    `got ${editedMinutes} minutes`,
  );

  // A price cannot be dropped below money already taken.
  await desk.rpc("record_payment", {
    p_appointment_id: editable,
    p_amount: 120,
    p_method: "cash",
    p_paid_at: null,
    p_note: "",
  });

  const { error: tooLow } = await desk.rpc("update_appointment_services", {
    p_appointment_id: editable,
    p_lines: [{ service_id: s.cut, quantity: 1 }],
    p_discount: 0,
    p_quoted_total: null,
  });
  check(
    "repricing below what has been paid is refused",
    Boolean(tooLow),
    tooLow?.message?.slice(0, 90),
  );

  const { error: staffEdits } = await staffClient.rpc("update_appointment_services", {
    p_appointment_id: editable,
    p_lines: [{ service_id: s.cut, quantity: 1 }],
    p_discount: 0,
    p_quoted_total: null,
  });
  check("a therapist cannot change a booking", Boolean(staffEdits));

  // A finished visit is a record, not work in progress.
  await admin.from("appointments").update({ status: "completed" }).eq("id", editable);
  const { error: editFinished } = await desk.rpc("update_appointment_services", {
    p_appointment_id: editable,
    p_lines: [{ service_id: s.cut, quantity: 1 }, { service_id: s.colour, quantity: 3 }],
    p_discount: 0,
    p_quoted_total: null,
  });
  check(
    "a completed appointment cannot be edited",
    Boolean(editFinished),
    editFinished?.message?.slice(0, 70),
  );



  /* ---------------------------------------------------------------- */
  console.log("\nPayroll: commission from the receipts already written\n");

  // Two FRESH therapists, so their figures are not polluted by everything the
  // earlier sections sold -- all of which is dated today, like this period.
  // One on each commission shape.
  const therapist2 = await makeUser(s.salonId, "staff", "therapist2");
  const therapist3 = await makeUser(s.salonId, "staff", "therapist3");
  const staff2Client = await clientFor(therapist2.email);
  const staff3Client = await clientFor(therapist3.email);

  const { error: compError } = await admin.from("staff_compensation").insert([
    // Every column is supplied on every row on purpose: a PostgREST bulk
    // insert unions the keys across the array and sends an explicit NULL for
    // any a row omits.
    {
      salon_id: s.salonId,
      staff_id: therapist2.memberId,
      commission_basis: "percentage",
      commission_rate: 0.3,
      fixed_amount: null,
      salary_amount: 0,
    },
    {
      salon_id: s.salonId,
      staff_id: therapist3.memberId,
      commission_basis: "fixed_per_service",
      commission_rate: null,
      fixed_amount: 7.5,
      salary_amount: 0,
    },
  ]);
  check("commission rates can be set", !compError, compError?.message);

  // A clean slate: everything sold so far is dated today, so put this period
  // on its own dates and sell into it.
  const { data: payrollCustomer } = await admin
    .from("customers")
    .insert({
      salon_id: s.salonId,
      full_name: "Payroll Customer",
      phone: `+1555${(Date.now() + 7) % 10000000}`,
    })
    .select("id")
    .single();

  async function sell(staffId, serviceId, quantity = 1) {
    const { data, error } = await desk.rpc("create_receipt", {
      p_customer_id: payrollCustomer.id,
      p_payment_method: "cash",
      p_cash_amount: 0,
      p_card_amount: 0,
      p_loyalty_redeem: 0,
      p_deal_id: null,
      p_notes: "",
      p_lines: [{ service_id: serviceId, staff_id: staffId, quantity }],
    });
    if (error) throw new Error(`payroll sale: ${error.message}`);
    return data;
  }

  // Therapist 2: a 40 cut and a 60 colour = 100 revenue, 2 services.
  await sell(therapist2.memberId, s.cut);
  await sell(therapist2.memberId, s.colour);
  // Therapist 3: three cuts on one line = 120 revenue, 3 services.
  await sell(therapist3.memberId, s.cut, 3);
  // A sale that will be voided, so it must not count towards therapist 2.
  const voidedSale = await sell(therapist2.memberId, s.colour);
  await ownerClient.rpc("void_receipt", {
    p_receipt_id: voidedSale,
    p_reason: "Rung up twice",
  });

  const today = new Date().toISOString().slice(0, 10);

  const { error: deskRuns } = await desk.rpc("generate_payroll_period", {
    p_starts_on: today,
    p_ends_on: today,
    p_notes: "",
  });
  check("a receptionist cannot run payroll", Boolean(deskRuns), deskRuns?.message?.slice(0, 70));

  const { error: staffRuns } = await staffClient.rpc("generate_payroll_period", {
    p_starts_on: today,
    p_ends_on: today,
    p_notes: "",
  });
  check("a therapist cannot run payroll", Boolean(staffRuns), staffRuns?.message?.slice(0, 70));

  const { data: periodId, error: periodError } = await ownerClient.rpc(
    "generate_payroll_period",
    { p_starts_on: today, p_ends_on: today, p_notes: "Test period" },
  );
  check("the owner can run payroll", !periodError, periodError?.message);

  const { data: entries } = await admin
    .from("payroll_entries")
    .select("*")
    .eq("period_id", periodId);

  const e2 = (entries ?? []).find((e) => e.staff_id === therapist2.memberId);
  const e3 = (entries ?? []).find((e) => e.staff_id === therapist3.memberId);

  // Therapist 1 appears too, carrying everything the earlier sections sold.
  check("an entry for every therapist who worked", (entries ?? []).length === 3);

  eqMoney("percentage therapist: revenue excludes the voided sale", e2?.revenue, 100);
  check(
    "percentage therapist: service count",
    e2?.services_performed === 2,
    `got ${e2?.services_performed}`,
  );
  eqMoney("percentage therapist: commission is 30% of revenue", e2?.commission_amount, 30);

  eqMoney("per-service therapist: revenue counts quantity", e3?.revenue, 120);
  check(
    "per-service therapist: service count counts quantity",
    e3?.services_performed === 3,
    `got ${e3?.services_performed}`,
  );
  eqMoney("per-service therapist: commission is per service", e3?.commission_amount, 22.5);

  check(
    "the settings used are snapshotted onto the entry",
    Number(e2?.commission_rate) === 0.3 && Number(e3?.fixed_amount) === 7.5,
  );

  // A therapist with no commission configured still appears, earning nothing.
  const e1 = (entries ?? []).find((e) => e.staff_id === s.therapist.memberId);
  eqMoney("a therapist with no rate set earns no commission", e1?.commission_amount, 0);
  check("but their revenue is still reported", Number(e1?.revenue) > 0);

  const { data: period } = await admin
    .from("payroll_periods")
    .select("*")
    .eq("id", periodId)
    .single();
  const entriesRevenue = (entries ?? []).reduce((sum, e) => sum + Number(e.revenue), 0);
  const entriesCommission = (entries ?? []).reduce(
    (sum, e) => sum + Number(e.commission_amount),
    0,
  );
  eqMoney("period revenue is the sum of its entries", period.total_revenue, entriesRevenue);
  eqMoney("period commission likewise", period.total_commission, entriesCommission);
  eqMoney("and only configured rates produce commission", period.total_commission, 52.5);
  check("a fresh period is a draft", period.status === "draft");

  /* ---------------------------------------------------------------- */
  console.log("\nFixed salary: paid for time, not for sales\n");

  /*
   * The third pay basis. Two things are being checked that the other two
   * cannot show:
   *
   *   1. Someone who performs NO services still appears on the run. Payroll
   *      used to derive its entry list from the receipt lines, so a salaried
   *      receptionist was invisible -- not paid zero, absent.
   *   2. A monthly figure is apportioned across an arbitrary period, a day at
   *      a time, so the length of the month matters and a mid-period joining
   *      date withholds the days before it.
   *
   * The periods below sit in months with no sales in them, so the salary is
   * the only thing on the payslip and the arithmetic is unambiguous.
   */
  const salaried = await makeUser(s.salonId, "receptionist", "salaried");
  const { error: salaryCompError } = await admin.from("staff_compensation").insert({
    salon_id: s.salonId,
    staff_id: salaried.memberId,
    // Salary-only: a salary, and commission explicitly switched off so a
    // service's own default rate cannot leak in.
    commission_basis: "none",
    commission_rate: null,
    fixed_amount: null,
    salary_amount: 30000,
    joining_date: null,
  });
  check("a salary can be set", !salaryCompError, salaryCompError?.message);

  async function runPeriod(from, to) {
    const { data: id, error } = await ownerClient.rpc("generate_payroll_period", {
      p_starts_on: from,
      p_ends_on: to,
      p_notes: "salary test",
    });
    if (error) throw new Error(`payroll ${from}..${to}: ${error.message}`);
    const { data: rows } = await admin.from("payroll_entries").select("*").eq("period_id", id);
    return { id, rows: rows ?? [] };
  }

  // April 2026: 30 days, whole month, no sales anywhere in it.
  const april = await runPeriod("2026-04-01", "2026-04-30");
  const aprilSalary = april.rows.find((e) => e.staff_id === salaried.memberId);

  check(
    "a salaried member appears even having performed nothing",
    Boolean(aprilSalary),
    "no payroll entry was created for them",
  );
  check(
    "and performed no services",
    Number(aprilSalary?.services_performed) === 0 && Number(aprilSalary?.revenue) === 0,
  );
  eqMoney("a whole month pays the whole salary", aprilSalary?.commission_amount, 30000);
  check(
    "every day of the month is paid",
    Number(aprilSalary?.salary_days_paid) === 30,
    `got ${aprilSalary?.salary_days_paid}`,
  );
  eqMoney("the monthly figure is snapshotted", aprilSalary?.salary_amount, 30000);
  check("on the salary basis", aprilSalary?.commission_basis === "none");
  check(
    "with the pay attributed to salary, not commission",
    Number(aprilSalary?.salary_pay) === 30000 && Number(aprilSalary?.commission_pay) === 0,
    `salary=${aprilSalary?.salary_pay} commission=${aprilSalary?.commission_pay}`,
  );

  // Only the salary basis pays in the absence of work. A commission therapist
  // who sold nothing in the period is owed nothing and is left off the run
  // entirely, rather than appearing as a row of zeroes.
  check(
    "a commission therapist with no sales is left off the run",
    !april.rows.some((e) => e.staff_id === therapist2.memberId),
    "they appeared on a period they did no work in",
  );
  check(
    "so an empty month lists only the salaried",
    april.rows.every((e) => Number(e.salary_pay) > 0),
  );

  // May 2026: 31 days, so half of it is 15/31 -- NOT half the salary. This is
  // the case a naive "days / period length" pro-rating gets wrong.
  const may = await runPeriod("2026-05-01", "2026-05-15");
  const maySalary = may.rows.find((e) => e.staff_id === salaried.memberId);
  eqMoney(
    "a part month pays by the length of that month",
    maySalary?.commission_amount,
    14516.13,
  );
  check("and says how many days it paid", Number(maySalary?.salary_days_paid) === 15);

  // A joining date inside the period: the days before it earn nothing.
  await admin
    .from("staff_compensation")
    .update({ joining_date: "2026-06-16" })
    .eq("staff_id", salaried.memberId);

  const june = await runPeriod("2026-06-01", "2026-06-30");
  const juneSalary = june.rows.find((e) => e.staff_id === salaried.memberId);
  eqMoney("joining mid-period pays only from the joining date", juneSalary?.commission_amount, 15000);
  check("and counts only the payable days", Number(juneSalary?.salary_days_paid) === 15);

  // Before they joined at all.
  const march = await runPeriod("2026-03-01", "2026-03-31");
  const marchSalary = march.rows.find((e) => e.staff_id === salaried.memberId);
  eqMoney("a period entirely before joining pays nothing", marchSalary?.commission_amount, 0);

  // The wage bill on the period has to include salaries, or the owner's total
  // understates what they owe.
  const { data: junePeriod } = await admin
    .from("payroll_periods")
    .select("total_commission")
    .eq("id", june.id)
    .single();
  const juneTotal = june.rows.reduce((sum, e) => sum + Number(e.commission_amount), 0);
  eqMoney("the period total includes the salary", junePeriod.total_commission, juneTotal);
  check("which is more than zero", Number(junePeriod.total_commission) >= 15000);

  /*
   * Leaving the TEAM stops the salary. Deliberately not "losing the login":
   * since the split those are different events, and someone can be taken off
   * the rota while their account survives, or keep working after their login
   * is revoked. Payroll follows the roster.
   */
  await admin
    .from("team_members")
    .update({ is_active: false })
    .eq("id", salaried.memberId);
  const july = await runPeriod("2026-07-01", "2026-07-31");
  check(
    "a deactivated member draws no further salary",
    !july.rows.some((e) => e.staff_id === salaried.memberId),
    "they were still on the payroll run",
  );
  await admin.from("team_members").update({ is_active: true }).eq("id", salaried.memberId);

  // A salaried member can read their own pay settings, and nobody else's --
  // the same rule the other two bases follow.
  const salariedClient = await clientFor(salaried.email);
  const { data: ownRate } = await salariedClient.from("staff_compensation").select("*");
  check(
    "a salaried member sees only their own pay settings",
    (ownRate ?? []).length === 1 && ownRate[0].staff_id === salaried.memberId,
    `got ${(ownRate ?? []).length} rows`,
  );
  eqMoney("including their salary", ownRate?.[0]?.salary_amount, 30000);

  /* ---------------------------------------------------------------- */
  console.log("\nCommission precedence: staff rate, else service, else nothing\n");

  /*
   * The rule, checked directly against the function that states it, before
   * checking it again through a whole payroll run below.
   *
   *   1. the staff member's own basis wins -- including an explicit 'none'
   *      and a deliberate 0%, both of which beat the service default
   *   2. otherwise the service's own default
   *   3. otherwise nothing
   */
  async function lineCommission(opts) {
    const { data, error } = await admin.rpc("line_commission", {
      p_line_total: opts.lineTotal,
      p_quantity: opts.quantity ?? 1,
      p_staff_basis: opts.staffBasis ?? null,
      p_staff_rate: opts.staffRate ?? null,
      p_staff_fixed: opts.staffFixed ?? null,
      p_service_basis: opts.serviceBasis ?? null,
      p_service_rate: opts.serviceRate ?? null,
      p_service_fixed: opts.serviceFixed ?? null,
    });
    if (error) throw new Error(`line_commission: ${error.message}`);
    return Number(data);
  }

  eqMoney(
    "neither set: the line earns nothing",
    await lineCommission({ lineTotal: 100 }),
    0,
  );
  eqMoney(
    "the service's own rate applies when the staff has none",
    await lineCommission({ lineTotal: 100, serviceBasis: "percentage", serviceRate: 0.1 }),
    10,
  );
  eqMoney(
    "a service's fixed rate counts the quantity",
    await lineCommission({
      lineTotal: 100, quantity: 3, serviceBasis: "fixed_per_service", serviceFixed: 5,
    }),
    15,
  );
  eqMoney(
    "the staff rate overrides the service's",
    await lineCommission({
      lineTotal: 100,
      staffBasis: "percentage", staffRate: 0.3,
      serviceBasis: "percentage", serviceRate: 0.1,
    }),
    30,
  );
  eqMoney(
    "an explicit 'none' beats the service default -- which is what makes salary-only mean it",
    await lineCommission({
      lineTotal: 100,
      staffBasis: "none",
      serviceBasis: "percentage", serviceRate: 0.1,
    }),
    0,
  );
  eqMoney(
    "and a deliberate 0% likewise overrides, rather than falling back",
    await lineCommission({
      lineTotal: 100,
      staffBasis: "percentage", staffRate: 0,
      serviceBasis: "percentage", serviceRate: 0.1,
    }),
    0,
  );
  eqMoney(
    "a staff fixed rate beats a service percentage",
    await lineCommission({
      lineTotal: 100, quantity: 2,
      staffBasis: "fixed_per_service", staffFixed: 7,
      serviceBasis: "percentage", serviceRate: 0.5,
    }),
    14,
  );

  /* ---------------------------------------------------------------- */
  console.log("\nThree pay models in one salon, one payroll run\n");

  /*
   * A salon of its own, because the periods above already cover today here and
   * two periods may not overlap. Everything below sells today and is paid by
   * one run, which is the point: salary-only, commission-only and hybrid have
   * to coexist in the same period.
   */
  const s2 = await buildSalon();
  const owner2 = await clientFor(s2.owner.email);
  const desk2 = await clientFor(s2.receptionist.email);

  // Service-level defaults: the cut pays 10% of its value, the colour pays a
  // flat 5, and the odd-priced one pays nothing at all.
  await admin
    .from("services")
    .update({ commission_basis: "percentage", commission_rate: 0.1, commission_fixed: null })
    .eq("id", s2.cut);
  await admin
    .from("services")
    .update({ commission_basis: "fixed_per_service", commission_rate: null, commission_fixed: 5 })
    .eq("id", s2.colour);

  async function therapistIn2(label) {
    const user = await makeUser(s2.salonId, "staff", label);
    return user.memberId;
  }

  const salaryOnly = await therapistIn2("salaryonly");
  const commissionOnly = await therapistIn2("commissiononly");
  const hybrid = await therapistIn2("hybrid");

  const { error: modelsError } = await admin.from("staff_compensation").insert([
    {
      // (a) salary only -- explicitly no commission, so the service defaults
      //     below must not reach them.
      salon_id: s2.salonId, staff_id: salaryOnly,
      commission_basis: "none", commission_rate: null, fixed_amount: null,
      salary_amount: 12000, joining_date: null,
    },
    {
      // (b) commission only -- no salary, and no personal rate, so each
      //     service's own default applies.
      salon_id: s2.salonId, staff_id: commissionOnly,
      commission_basis: null, commission_rate: null, fixed_amount: null,
      salary_amount: 0, joining_date: null,
    },
    {
      // (c) hybrid -- a base salary AND commission on top. This is the
      //     arrangement the old single-enum model could not express at all.
      salon_id: s2.salonId, staff_id: hybrid,
      commission_basis: "percentage", commission_rate: 0.2, fixed_amount: null,
      salary_amount: 9000, joining_date: null,
    },
  ]);
  check("all three arrangements can be saved", !modelsError, modelsError?.message);

  // Each of them sells a 40 cut and a 60 colour.
  async function sellIn2(staffId) {
    const { error } = await desk2.rpc("create_receipt", {
      p_customer_id: s2.customerId,
      p_payment_method: "cash",
      p_cash_amount: 0,
      p_card_amount: 0,
      p_loyalty_redeem: 0,
      p_deal_id: null,
      p_notes: "",
      p_lines: [
        { service_id: s2.cut, staff_id: staffId, quantity: 1 },
        { service_id: s2.colour, staff_id: staffId, quantity: 1 },
      ],
    });
    if (error) throw new Error(`sale: ${error.message}`);
  }

  await sellIn2(salaryOnly);
  await sellIn2(commissionOnly);
  await sellIn2(hybrid);

  const runDay = new Date().toISOString().slice(0, 10);
  const { data: modelPeriod, error: modelRunError } = await owner2.rpc(
    "generate_payroll_period",
    { p_starts_on: runDay, p_ends_on: runDay, p_notes: "three models" },
  );
  check("the run completes", !modelRunError, modelRunError?.message);

  const { data: modelRows } = await admin
    .from("payroll_entries")
    .select("*")
    .eq("period_id", modelPeriod);

  const byStaff = (id) => (modelRows ?? []).find((e) => e.staff_id === id);

  // One day of a salary is that day's share of its own month.
  const { data: oneDay12k } = await admin.rpc("prorated_salary", {
    p_monthly: 12000, p_starts_on: runDay, p_ends_on: runDay, p_joined_on: null,
  });
  const { data: oneDay9k } = await admin.rpc("prorated_salary", {
    p_monthly: 9000, p_starts_on: runDay, p_ends_on: runDay, p_joined_on: null,
  });

  /* ---- (a) salary only ---- */
  const a = byStaff(salaryOnly);
  check("the salary-only member is on the run", Boolean(a));
  eqMoney("their salary is paid", a?.salary_pay, Number(oneDay12k));
  eqMoney(
    "and they earn NO commission, despite the services carrying rates",
    a?.commission_pay,
    0,
  );
  eqMoney("so their total is the salary alone", a?.commission_amount, Number(oneDay12k));
  check("their revenue is still reported", Number(a?.revenue) === 100);

  /* ---- (b) commission only ---- */
  const b = byStaff(commissionOnly);
  check("the commission-only member is on the run", Boolean(b));
  eqMoney("they draw no salary", b?.salary_pay, 0);
  // 10% of the 40 cut, plus a flat 5 for the colour.
  eqMoney("their commission comes from each service's own rate", b?.commission_pay, 9);
  eqMoney("and that is their whole pay", b?.commission_amount, 9);

  /* ---- (c) hybrid ---- */
  const c = byStaff(hybrid);
  check("the hybrid member is on the run", Boolean(c));
  eqMoney("their base salary is paid", c?.salary_pay, Number(oneDay9k));
  // Their own 20% overrides both service defaults: 20% of 100.
  eqMoney("AND commission on top, at their own overriding rate", c?.commission_pay, 20);
  eqMoney(
    "the total is the two added, not one or the other",
    c?.commission_amount,
    Math.round((Number(oneDay9k) + 20) * 100) / 100,
  );

  /* ---- the period totals ---- */
  const { data: modelPeriodRow } = await admin
    .from("payroll_periods")
    .select("total_commission")
    .eq("id", modelPeriod)
    .single();
  const modelSum = (modelRows ?? []).reduce((n, e) => n + Number(e.commission_amount), 0);
  eqMoney("the wage bill is the sum of the entries", modelPeriodRow.total_commission, modelSum);
  check(
    "every entry's halves add up to its total",
    (modelRows ?? []).every(
      (e) =>
        Math.abs(Number(e.salary_pay) + Number(e.commission_pay) - Number(e.commission_amount)) <
        0.005,
    ),
  );

  /* ---- a service with no rate pays nothing to an unset staff member ---- */
  await sellIn2(commissionOnly);
  const { error: oddSale } = await desk2.rpc("create_receipt", {
    p_customer_id: s2.customerId,
    p_payment_method: "cash",
    p_cash_amount: 0,
    p_card_amount: 0,
    p_loyalty_redeem: 0,
    p_deal_id: null,
    p_notes: "",
    p_lines: [{ service_id: s2.odd, staff_id: commissionOnly, quantity: 1 }],
  });
  check("a service with no commission rate can still be sold", !oddSale, oddSale?.message);

  const { data: check2 } = await admin.rpc("line_commission", {
    p_line_total: 33.33, p_quantity: 1,
    p_staff_basis: null, p_staff_rate: null, p_staff_fixed: null,
    p_service_basis: null, p_service_rate: null, p_service_fixed: null,
  });
  eqMoney("and it earns nobody anything", check2, 0);





  /* ---------------------------------------------------------------- */
  console.log("\nWho can see what\n");

  const { data: ownerSeesPeriods } = await ownerClient.from("payroll_periods").select("id");
  check("the owner sees payroll periods", (ownerSeesPeriods ?? []).length > 0);

  const { data: deskSeesPeriods } = await desk.from("payroll_periods").select("id");
  check("a receptionist sees no payroll periods", (deskSeesPeriods ?? []).length === 0);

  const { data: staffSeesPeriods } = await staffClient.from("payroll_periods").select("id");
  check("a therapist sees no payroll periods", (staffSeesPeriods ?? []).length === 0);

  const { data: staff2SeesEntries } = await staff2Client
    .from("payroll_entries")
    .select("staff_id, commission_amount");
  check(
    "a therapist sees only their own earnings",
    (staff2SeesEntries ?? []).length === 1 &&
      staff2SeesEntries[0].staff_id === therapist2.memberId,
    `saw ${(staff2SeesEntries ?? []).length}`,
  );

  const { data: staff3SeesEntries } = await staff3Client.from("payroll_entries").select("staff_id");
  check(
    "and another therapist sees only theirs",
    (staff3SeesEntries ?? []).length === 1 &&
      staff3SeesEntries[0].staff_id === therapist3.memberId,
  );

  const { data: deskSeesEntries } = await desk.from("payroll_entries").select("id");
  check("a receptionist sees no payroll entries", (deskSeesEntries ?? []).length === 0);

  const { data: staffSeesOwnRate } = await staff2Client
    .from("staff_compensation")
    .select("staff_id, commission_rate");
  check(
    "a therapist can see their own commission rate",
    (staffSeesOwnRate ?? []).length === 1 &&
      staffSeesOwnRate[0].staff_id === therapist2.memberId,
    `saw ${(staffSeesOwnRate ?? []).length}`,
  );
  check(
    "and no colleague rate",
    (staffSeesOwnRate ?? []).every((r) => r.staff_id !== therapist3.memberId),
  );

  const { data: deskSeesRates } = await desk.from("staff_compensation").select("staff_id");
  check("a receptionist sees no commission rates at all", (deskSeesRates ?? []).length === 0);

  const { error: staffSetsRate } = await staff2Client
    .from("staff_compensation")
    .update({ commission_rate: 0.9 })
    .eq("staff_id", therapist2.memberId)
    .select();
  const { data: rateNow } = await admin
    .from("staff_compensation")
    .select("commission_rate")
    .eq("staff_id", therapist2.memberId)
    .single();
  check(
    "a therapist cannot raise their own rate",
    Number(rateNow.commission_rate) === 0.3,
    staffSetsRate?.message ?? "update matched no rows",
  );

  /* ---------------------------------------------------------------- */
  console.log("\nA paid period is history\n");

  const { error: deskPays } = await desk.rpc("mark_payroll_paid", { p_period_id: periodId });
  check("a receptionist cannot mark payroll paid", Boolean(deskPays), deskPays?.message?.slice(0, 70));

  const { error: paid } = await ownerClient.rpc("mark_payroll_paid", { p_period_id: periodId });
  check("the owner can mark it paid", !paid, paid?.message);

  const { data: paidPeriod } = await admin
    .from("payroll_periods")
    .select("status, paid_at, paid_by")
    .eq("id", periodId)
    .single();
  check("the period is marked paid", paidPeriod.status === "paid");
  check("with a timestamp", Boolean(paidPeriod.paid_at));
  check("and who paid it", paidPeriod.paid_by === s.owner.userId);

  const { data: paidEntries } = await admin
    .from("payroll_entries")
    .select("status, paid_at")
    .eq("period_id", periodId);
  check(
    "its entries are marked paid too",
    (paidEntries ?? []).every((e) => e.status === "paid" && e.paid_at),
  );

  const { error: editPaid } = await ownerClient
    .from("payroll_periods")
    .update({ total_commission: 1 })
    .eq("id", periodId)
    .select();
  const { data: unchanged } = await admin
    .from("payroll_periods")
    .select("total_commission")
    .eq("id", periodId)
    .single();
  eqMoney(
    "a paid period cannot be edited",
    unchanged.total_commission,
    52.5,
    editPaid?.message?.slice(0, 60),
  );

  const { error: deletePaid } = await ownerClient
    .from("payroll_periods")
    .delete()
    .eq("id", periodId)
    .select();
  const { data: stillThere } = await admin
    .from("payroll_periods")
    .select("id")
    .eq("id", periodId)
    .maybeSingle();
  check(
    "a paid period cannot be deleted",
    Boolean(stillThere),
    deletePaid?.message ?? "delete matched no rows",
  );

  const { error: payTwice } = await ownerClient.rpc("mark_payroll_paid", {
    p_period_id: periodId,
  });
  check("a period cannot be paid twice", Boolean(payTwice), payTwice?.message?.slice(0, 70));

  const { error: editEntry } = await ownerClient
    .from("payroll_entries")
    .update({ commission_amount: 1 })
    .eq("period_id", periodId)
    .select();
  const { data: entryNow } = await admin
    .from("payroll_entries")
    .select("commission_amount")
    .eq("period_id", periodId)
    .eq("staff_id", therapist2.memberId)
    .single();
  eqMoney(
    "a paid entry cannot be edited",
    entryNow.commission_amount,
    30,
    editEntry?.message?.slice(0, 60),
  );

  /* ---------------------------------------------------------------- */
  console.log("\nPeriods cannot overlap, so work is never paid twice\n");

  const { error: overlapping } = await ownerClient.rpc("generate_payroll_period", {
    p_starts_on: today,
    p_ends_on: today,
    p_notes: "again",
  });
  check("an overlapping period is refused", Boolean(overlapping), overlapping?.code ?? "");

  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const { data: priorPeriod, error: priorError } = await ownerClient.rpc(
    "generate_payroll_period",
    { p_starts_on: yesterday, p_ends_on: yesterday, p_notes: "prior" },
  );
  check("a non-overlapping period is fine", !priorError, priorError?.message);

  // A draft generated for the wrong dates can be thrown away and redone.
  const { error: dropDraft } = await ownerClient
    .from("payroll_periods")
    .delete()
    .eq("id", priorPeriod);
  const { data: draftGone } = await admin
    .from("payroll_periods")
    .select("id")
    .eq("id", priorPeriod)
    .maybeSingle();
  check("a draft period can be discarded", !draftGone, dropDraft?.message);

  /* ---------------------------------------------------------------- */
  console.log("\nPayroll audit trail\n");

  const { data: payrollAudit } = await ownerClient
    .from("audit_logs")
    .select("action")
    .in("action", ["payroll.generated", "payroll.marked_paid"]);
  const payrollActions = new Set((payrollAudit ?? []).map((a) => a.action));
  check("generating payroll is audited", payrollActions.has("payroll.generated"));
  check("marking it paid is audited", payrollActions.has("payroll.marked_paid"));

  /* ---------------------------------------------------------------- */
  console.log("\nAudit trail\n");

  const { data: auditEntries } = await ownerClient
    .from("audit_logs")
    .select("action")
    .in("action", ["receipt.created", "receipt.voided", "loyalty.redeemed"]);
  const actions = new Set((auditEntries ?? []).map((a) => a.action));
  check("receipt creation is audited", actions.has("receipt.created"));
  check("voiding is audited", actions.has("receipt.voided"));
  check("loyalty redemption is audited", actions.has("loyalty.redeemed"));

  const { data: auditSample } = await ownerClient
    .from("audit_logs")
    .select("metadata")
    .eq("action", "receipt.voided")
    .limit(1)
    .single();
  check(
    "the void entry records the reason",
    String(auditSample?.metadata?.reason ?? "").length > 0,
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
