// Run: node --experimental-strip-types scripts/ics.check.ts
import assert from "node:assert/strict";
import { occurrences, parseIcs } from "../src/ics.ts";

const ics = (events: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}END:VCALENDAR\r\n`;
const ev = (lines: string) => `BEGIN:VEVENT\r\n${lines.trim().split("\n").map((l) => l.trim().replace(/^~/, " ")).join("\r\n")}\r\nEND:VEVENT\r\n`;
const iso = (t: number) => new Date(t).toISOString();
const Z = (s: string) => Date.parse(s);

// UTC event, folded (~ = leading space) + escaped summary, alarm SUMMARY ignored
{
  const raws = parseIcs(
    ics(ev(`UID:a
      DTSTART:20261118T150000Z
      DTEND:20261118T160000Z
      SUMMARY:Design review\\, round
      ~two
      BEGIN:VALARM
      SUMMARY:alarm text
      END:VALARM`)),
  );
  const [o] = occurrences(raws, Z("2026-11-18T00:00:00Z"), Z("2026-11-19T00:00:00Z"));
  assert.equal(o.title, "Design review, roundtwo");
  assert.equal(iso(o.start), "2026-11-18T15:00:00.000Z");
  assert.equal(o.end - o.start, 3_600_000);
}

// TZID: 9:00 New York in November (EST, UTC-5) and July (EDT, UTC-4)
{
  const raws = parseIcs(
    ics(
      ev(`UID:b
        DTSTART;TZID=America/New_York:20261118T090000
        DURATION:PT30M
        SUMMARY:Standup`) +
        ev(`UID:c
        DTSTART;TZID="America/New_York":20260715T090000
        SUMMARY:Summer`),
    ),
  );
  const os = occurrences(raws, Z("2026-01-01T00:00:00Z"), Z("2027-01-01T00:00:00Z"));
  assert.deepEqual(os.map((o) => iso(o.start)), ["2026-07-15T13:00:00.000Z", "2026-11-18T14:00:00.000Z"]);
  assert.equal(os[1].end - os[1].start, 30 * 60_000);
}

// Weekly MO/WE/FR with COUNT, an EXDATE, and one moved instance
{
  const raws = parseIcs(
    ics(
      ev(`UID:w
        DTSTART:20261102T090000Z
        DTEND:20261102T093000Z
        RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6
        EXDATE:20261104T090000Z
        SUMMARY:Sync`) +
        ev(`UID:w
        RECURRENCE-ID:20261106T090000Z
        DTSTART:20261106T130000Z
        DTEND:20261106T133000Z
        SUMMARY:Sync (moved)`),
    ),
  );
  const os = occurrences(raws, Z("2026-11-01T00:00:00Z"), Z("2026-12-01T00:00:00Z"));
  assert.deepEqual(
    os.map((o) => `${iso(o.start).slice(0, 13)} ${o.title}`),
    ["2026-11-02T09 Sync", "2026-11-06T13 Sync (moved)", "2026-11-09T09 Sync", "2026-11-11T09 Sync", "2026-11-13T09 Sync"],
  );
}

// Daily since 2015 with no end: fast-forward still finds today; UNTIL stops a series
{
  const raws = parseIcs(
    ics(
      ev(`UID:d
        DTSTART:20150101T080000Z
        DTEND:20150101T081500Z
        RRULE:FREQ=DAILY
        SUMMARY:Journal`) +
        ev(`UID:u
        DTSTART:20261101T100000Z
        RRULE:FREQ=DAILY;UNTIL=20261103T100000Z
        SUMMARY:Short run`),
    ),
  );
  const os = occurrences(raws, Z("2026-11-18T00:00:00Z"), Z("2026-11-19T00:00:00Z"));
  assert.deepEqual(os.map((o) => `${iso(o.start)} ${o.title}`), ["2026-11-18T08:00:00.000Z Journal"]);
  const short = occurrences(raws, Z("2026-11-01T00:00:00Z"), Z("2026-11-10T00:00:00Z")).filter((o) => o.title === "Short run");
  assert.equal(short.length, 3);
}

// Monthly on the 31st skips short months; all-day and cancelled events
{
  const raws = parseIcs(
    ics(
      ev(`UID:m
        DTSTART:20260131T120000Z
        RRULE:FREQ=MONTHLY;COUNT=4
        SUMMARY:Rent`) +
        ev(`UID:ad
        DTSTART;VALUE=DATE:20261118
        DTEND;VALUE=DATE:20261119
        SUMMARY:Holiday`) +
        ev(`UID:x
        DTSTART:20261118T120000Z
        STATUS:CANCELLED
        SUMMARY:Gone`),
    ),
  );
  const rent = occurrences(raws, Z("2026-01-01T00:00:00Z"), Z("2027-01-01T00:00:00Z")).filter((o) => o.title === "Rent");
  assert.deepEqual(rent.map((o) => iso(o.start).slice(0, 10)), ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]);
  const day = occurrences(raws, Z("2026-11-17T00:00:00Z"), Z("2026-11-20T00:00:00Z"));
  assert.deepEqual(day.map((o) => [o.title, o.allDay, o.end - o.start]), [["Holiday", true, 86_400_000]]);
}

console.log("ics checks passed");
