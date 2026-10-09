/**
 * Salon-local time conversions.
 *
 * Booking is the first place the product has to hold two clocks at once: an
 * appointment is stored as an instant, but entered and read as wall-clock time
 * in the salon's own zone. Getting that wrong is the kind of bug that only
 * shows up twice a year, so it is pinned down here.
 *
 *   npm run test:time
 *
 * Pure computation -- no database, no network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const source = fs.readFileSync("src/lib/time.ts", "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});

const compiled = path.join(os.tmpdir(), `salon-time-${process.pid}.mjs`);
fs.writeFileSync(compiled, outputText);

let t;
try {
  t = await import(`file://${compiled.split(path.sep).join("/")}`);
} finally {
  fs.rmSync(compiled, { force: true });
}

let passed = 0;
let failed = 0;

function eq(label, actual, expected) {
  if (actual === expected) {
    passed += 1;
    console.log(`  \u001b[32mPASS\u001b[0m  ${label}`);
  } else {
    failed += 1;
    console.log(`  \u001b[31mFAIL\u001b[0m  ${label} -- got ${actual}, wanted ${expected}`);
  }
}

console.log("\nA zone with no daylight saving (Asia/Karachi, UTC+5)\n");

const karachi = t.salonTimeToInstant("2026-07-15", "09:30", "Asia/Karachi");
eq("09:30 local becomes the right instant", karachi.toISOString(), "2026-07-15T04:30:00.000Z");
eq("the date survives the round trip", t.instantToSalonDate(karachi, "Asia/Karachi"), "2026-07-15");
eq("the time survives the round trip", t.instantToSalonTime(karachi, "Asia/Karachi"), "09:30");

console.log("\nA zone that does observe it (Europe/London)\n");

eq(
  "summer is UTC+1",
  t.salonTimeToInstant("2026-07-15", "09:30", "Europe/London").toISOString(),
  "2026-07-15T08:30:00.000Z",
);
eq(
  "winter is UTC+0",
  t.salonTimeToInstant("2026-01-15", "09:30", "Europe/London").toISOString(),
  "2026-01-15T09:30:00.000Z",
);

// The morning the UK clocks go forward. A single-pass offset lookup lands on
// the wrong side of the shift here, which is what the correction pass fixes.
const dstDay = t.salonTimeToInstant("2026-03-29", "09:30", "Europe/London");
eq("the clocks-change morning resolves correctly", dstDay.toISOString(), "2026-03-29T08:30:00.000Z");
eq("and still round trips", t.instantToSalonTime(dstDay, "Europe/London"), "09:30");

console.log("\nMidnight and the dateline\n");

const midnight = t.salonTimeToInstant("2026-07-15", "00:00", "Asia/Karachi");
eq("midnight renders as 00:00, not 24:00", t.instantToSalonTime(midnight, "Asia/Karachi"), "00:00");
eq("midnight stays on its own date", t.instantToSalonDate(midnight, "Asia/Karachi"), "2026-07-15");

// Auckland is far enough east that its morning is the previous day in UTC.
const auckland = t.salonTimeToInstant("2026-07-15", "09:00", "Pacific/Auckland");
eq("a far-eastern morning is the previous UTC day", auckland.toISOString(), "2026-07-14T21:00:00.000Z");
eq(
  "but reads as its own local date",
  t.instantToSalonDate(auckland, "Pacific/Auckland"),
  "2026-07-15",
);

console.log("\nCalendar arithmetic\n");

eq("weekday key", t.weekdayKey("2026-09-22"), "tue");
eq("week starts on Monday", t.startOfWeek("2026-09-22"), "2026-09-21");
eq("a Monday is its own week start", t.startOfWeek("2026-09-21"), "2026-09-21");
eq("a Sunday belongs to the week before", t.startOfWeek("2026-09-27"), "2026-09-21");
eq("adding a day crosses a month", t.addDays("2026-01-31", 1), "2026-02-01");
eq("adding a day crosses a year", t.addDays("2026-12-31", 1), "2027-01-01");
eq("leap day exists in 2028", t.addDays("2028-02-28", 1), "2028-02-29");
eq("minutes from time", t.minutesFromTime("09:30"), 570);
eq("time from minutes", t.timeFromMinutes(570), "09:30");
eq("time from minutes pads", t.timeFromMinutes(65), "01:05");

console.log("\nMonth and range arithmetic\n");

eq("start of month", t.startOfMonth("2026-09-22"), "2026-09-01");
eq("start of month on the first", t.startOfMonth("2026-09-01"), "2026-09-01");
eq("end of a 30-day month", t.endOfMonth("2026-09-22"), "2026-09-30");
eq("end of a 31-day month", t.endOfMonth("2026-01-05"), "2026-01-31");
eq("end of February", t.endOfMonth("2026-02-10"), "2026-02-28");
eq("end of a leap February", t.endOfMonth("2028-02-10"), "2028-02-29");
eq("end of December", t.endOfMonth("2026-12-09"), "2026-12-31");
eq("a single day is one day", t.daysInRange("2026-09-22", "2026-09-22"), 1);
eq("both ends are counted", t.daysInRange("2026-09-01", "2026-09-30"), 30);
eq("a range across a month boundary", t.daysInRange("2026-01-30", "2026-02-02"), 4);
eq("a range across a DST change counts whole days", t.daysInRange("2026-03-28", "2026-03-30"), 3);

// The salon's clock, not the machine's -- the reason this exists rather than
// reusing formatDateTime from @/lib/format.
{
  const instant = "2026-09-22T21:30:00.000Z";
  const karachi = t.formatInstantInSalon(instant, "Asia/Karachi");
  const auckland = t.formatInstantInSalon(instant, "Pacific/Auckland");
  eq("an instant renders at the salon own clock", karachi.endsWith("02:30"), true);
  eq("and rolls into the next local day where it should", auckland.endsWith("09:30"), true);
  eq("the two zones disagree, as they must", karachi === auckland, false);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
