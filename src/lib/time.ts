/**
 * Salon-local time.
 *
 * Appointments are stored as instants (`timestamptz`), but people book in the
 * salon's wall-clock time. Everything here converts between the two using the
 * salon's IANA timezone, so a salon in Karachi and one in London can sit in the
 * same database without either seeing the other's hours.
 *
 * Deliberately dependency-free: `Intl` already knows every zone's rules,
 * including historical and daylight-saving shifts.
 */

/** How far ahead of UTC the zone is, in milliseconds, at a given instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  // Intl renders hour 24 for midnight under hour12:false in some engines.
  const hour = get("hour") % 24;

  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );

  return asUtc - instant.getTime();
}

/**
 * Turn a wall-clock date and time in the salon's zone into an instant.
 *
 * The offset depends on the instant we are trying to find, so this guesses,
 * measures the offset there, and corrects. The second pass matters only near a
 * daylight-saving boundary, where the first guess can land on the wrong side.
 */
export function salonTimeToInstant(
  date: string,
  time: string,
  timeZone: string,
): Date {
  const naive = new Date(`${date}T${time}:00.000Z`);
  if (Number.isNaN(naive.getTime())) {
    throw new Error(`Invalid date or time: ${date} ${time}`);
  }

  const firstGuess = new Date(naive.getTime() - zoneOffsetMs(naive, timeZone));
  const corrected = new Date(naive.getTime() - zoneOffsetMs(firstGuess, timeZone));
  return corrected;
}

/** The salon-local calendar day (YYYY-MM-DD) that an instant falls on. */
export function instantToSalonDate(instant: Date | string, timeZone: string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** The salon-local clock time (HH:MM) that an instant falls on. */
export function instantToSalonTime(instant: Date | string, timeZone: string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    // h23 rather than hour12:false -- the latter renders midnight as "24:00"
    // in some engines, which then parses back as the wrong day.
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Today, as the salon reckons it. */
export function salonToday(timeZone: string): string {
  return instantToSalonDate(new Date(), timeZone);
}

/** Minutes since midnight, from an "HH:MM" string. */
export function minutesFromTime(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

export function timeFromMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Shift a YYYY-MM-DD by whole days, without touching timezones. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  const d = new Date(`${date}T12:00:00.000Z`);
  // getUTCDay() is 0 for Sunday; shift so Monday is 0.
  const weekday = (d.getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** Which business-hours key a YYYY-MM-DD falls on. */
export function weekdayKey(date: string): WeekdayKey {
  const d = new Date(`${date}T12:00:00.000Z`);
  return WEEKDAY_KEYS[(d.getUTCDay() + 6) % 7];
}

/*
 * Day labels take a YYYY-MM-DD that is *already* the salon's calendar date, so
 * they render it in UTC. Re-zoning it would shift the label by a day for the
 * salon itself in far-eastern and far-western zones.
 */
export function formatDayLabel(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T12:00:00.000Z`));
}

export function formatLongDayLabel(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00.000Z`));
}

/** The first day of the month containing `date`. */
export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The last day of the month containing `date`. */
export function endOfMonth(date: string): string {
  const d = new Date(`${startOfMonth(date)}T12:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, inclusive of both ends. */
export function daysInRange(from: string, to: string): number {
  const a = new Date(`${from}T12:00:00.000Z`).getTime();
  const b = new Date(`${to}T12:00:00.000Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * An instant rendered in the salon's own zone, e.g. "Sat, 20 Sep, 14:30".
 *
 * `formatDateTime` in @/lib/format uses whatever zone the machine is in, which
 * is right for a browser and wrong for a server render. Anything that states
 * when something happened to the salon comes through here instead.
 */
export function formatInstantInSalon(instant: Date | string, timeZone: string): string {
  return `${formatDayLabel(instantToSalonDate(instant, timeZone))}, ${instantToSalonTime(instant, timeZone)}`;
}
