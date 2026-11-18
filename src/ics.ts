// Minimal iCalendar (.ics) reader: VEVENTs with time zones, all-day events, and the common
// RRULE shapes (DAILY / WEEKLY+BYDAY / MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL), EXDATE and
// moved instances (RECURRENCE-ID).
// ponytail: MONTHLY BYDAY ("2nd Tuesday"), BYMONTHDAY lists and BYSETPOS are treated as
// "same day each month". Add them when a real calendar needs them.

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number }; // mo is 0-based
type Zone = string; // "Z" (UTC), "local", or an IANA zone like "America/New_York"
type Prop = { v: string; p: Record<string, string> };

export type Raw = {
  uid: string;
  title: string;
  start: Wall;
  zone: Zone;
  allDay: boolean;
  durMs: number;
  rrule?: Record<string, string>;
  exdates: number[];
  recurrenceId?: number;
};
export type Occ = { title: string; start: number; end: number; allDay: boolean };

const DAY = 86_400_000;
const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

const fmtCache = new Map<string, Intl.DateTimeFormat | null>();
function tzOffset(tz: string, t: number): number | null {
  let f = fmtCache.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      f = null; // not an IANA name (Outlook sometimes sends Windows zone names)
    }
    fmtCache.set(tz, f);
  }
  if (!f) return null;
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(t))) if (x.type !== "literal") p[x.type] = +x.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
}

/** Wall-clock time in a zone -> epoch ms. Unknown zones fall back to this PC's zone. */
export function instant(w: Wall, zone: Zone): number {
  const utc = Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s);
  if (zone === "Z") return utc;
  if (zone !== "local") {
    const o1 = tzOffset(zone, utc);
    if (o1 !== null) return utc - tzOffset(zone, utc - o1)!; // second pass settles DST edges
  }
  return new Date(w.y, w.mo, w.d, w.h, w.mi, w.s).getTime();
}

function parseDate(v: string, p: Record<string, string>) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(v);
  if (!m) return null;
  const allDay = !m[4];
  const wall: Wall = { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  const zone: Zone = m[7] ? "Z" : allDay ? "local" : (p.TZID ?? "local");
  return { wall, zone, allDay };
}

function parseDuration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) return 0;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 * 3600 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

const unescapeText = (s: string) => s.replace(/\\([nN,;\\])/g, (_, c) => (c === "n" || c === "N" ? " " : c));

function toRaw(c: Record<string, Prop[]>): Raw | null {
  const first = (k: string) => c[k]?.[0];
  if (first("STATUS")?.v.toUpperCase() === "CANCELLED") return null;
  const ds = first("DTSTART");
  const s = ds && parseDate(ds.v, ds.p);
  if (!s) return null;
  const t0 = instant(s.wall, s.zone);
  const de = first("DTEND");
  const e = de && parseDate(de.v, de.p);
  const du = first("DURATION");
  const durMs = e ? instant(e.wall, e.zone) - t0 : du ? parseDuration(du.v) : s.allDay ? DAY : 0;
  const rr = first("RRULE");
  const rrule = rr
    ? Object.fromEntries(rr.v.split(";").map((kv) => kv.split("=") as [string, string]))
    : undefined;
  const exdates = (c.EXDATE ?? []).flatMap((x) =>
    x.v.split(",").map((v) => {
      const d = parseDate(v, x.p);
      return d ? instant(d.wall, d.zone) : NaN;
    }),
  );
  const rid = first("RECURRENCE-ID");
  const r = rid && parseDate(rid.v, rid.p);
  return {
    uid: first("UID")?.v ?? "",
    title: unescapeText(first("SUMMARY")?.v ?? "") || "(No title)",
    start: s.wall,
    zone: s.zone,
    allDay: s.allDay,
    durMs,
    rrule,
    exdates,
    recurrenceId: r ? instant(r.wall, r.zone) : undefined,
  };
}

export function parseIcs(text: string): Raw[] {
  const out: Raw[] = [];
  let cur: Record<string, Prop[]> | null = null;
  let nested = 0; // inside VALARM etc. within a VEVENT
  for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      nested = 0;
      continue;
    }
    if (!cur) continue;
    if (line === "END:VEVENT") {
      const r = toRaw(cur);
      if (r) out.push(r);
      cur = null;
      continue;
    }
    if (line.startsWith("BEGIN:")) nested++;
    else if (line.startsWith("END:")) nested--;
    else if (nested === 0) {
      const c = line.indexOf(":");
      if (c < 0) continue;
      const [name, ...params] = line.slice(0, c).split(";");
      const p: Record<string, string> = {};
      for (const x of params) {
        const i = x.indexOf("=");
        if (i > 0) p[x.slice(0, i).toUpperCase()] = x.slice(i + 1).replace(/^"|"$/g, "");
      }
      (cur[name.toUpperCase()] ??= []).push({ v: line.slice(c + 1), p });
    }
  }
  return out;
}

const addDays = (w: Wall, n: number): Wall => {
  const t = new Date(Date.UTC(w.y, w.mo, w.d + n));
  return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() };
};
const weekday = (w: Wall) => (new Date(Date.UTC(w.y, w.mo, w.d)).getUTCDay() + 6) % 7; // Monday = 0
const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();

/** The k-th period start for simple rules, or null when that date doesn't exist (Feb 30). */
function nth(w: Wall, freq: string, k: number): Wall | null {
  if (freq === "DAILY") return addDays(w, k);
  if (freq === "WEEKLY") return addDays(w, 7 * k);
  const months = freq === "MONTHLY" ? w.mo + k : freq === "YEARLY" ? w.mo + 12 * k : NaN;
  if (Number.isNaN(months)) return k === 0 ? w : null;
  const y = w.y + Math.floor(months / 12);
  const mo = ((months % 12) + 12) % 12;
  return w.d <= daysIn(y, mo) ? { ...w, y, mo } : null;
}

/** Every occurrence overlapping [from, to), sorted by start. */
export function occurrences(raws: Raw[], from: number, to: number): Occ[] {
  const moved = new Set(raws.filter((r) => r.recurrenceId !== undefined).map((r) => `${r.uid}@${r.recurrenceId}`));
  const out: Occ[] = [];
  const push = (r: Raw, start: number) => {
    if (start < to && start + Math.max(r.durMs, 1) > from) out.push({ title: r.title, start, end: start + r.durMs, allDay: r.allDay });
  };
  for (const r of raws) {
    const t0 = instant(r.start, r.zone);
    const rule = r.rrule;
    if (!rule || r.recurrenceId !== undefined) {
      push(r, t0);
      continue;
    }
    const freq = rule.FREQ;
    const interval = Math.max(1, +(rule.INTERVAL || 1));
    const count = rule.COUNT ? +rule.COUNT : Infinity;
    const u = rule.UNTIL ? parseDate(rule.UNTIL, {}) : null;
    const until = u ? instant(u.wall, u.zone) + (u.allDay ? DAY - 1 : 0) : Infinity;
    const byday = freq === "WEEKLY" && rule.BYDAY ? rule.BYDAY.split(",").map((d) => DAYS.indexOf(d.slice(-2))) : null;
    // Without COUNT, skip straight to the periods near `from` instead of walking from DTSTART.
    const periodDays = freq === "DAILY" ? interval : freq === "WEEKLY" ? 7 * interval : 0;
    const k0 = count === Infinity && periodDays ? Math.max(0, Math.floor((from - t0) / (periodDays * DAY)) - 1) : 0;
    let n = 0;
    outer: for (let k = k0; k < k0 + 3000; k++) {
      const walls = byday
        ? byday.map((wd) => addDays(r.start, -weekday(r.start) + 7 * k * interval + wd))
        : [nth(r.start, freq, k * interval)];
      if (!byday && walls[0] === null && !["MONTHLY", "YEARLY"].includes(freq)) break;
      for (const w of walls.sort((a, b) => (a && b ? instant(a, r.zone) - instant(b, r.zone) : 0))) {
        if (!w) continue;
        const t = instant(w, r.zone);
        if (t < t0) continue;
        if (t > until || n >= count) break outer;
        n++;
        if (t >= to) break outer;
        if (!r.exdates.includes(t) && !moved.has(`${r.uid}@${t}`)) push(r, t);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
