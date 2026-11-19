// Run: node --experimental-strip-types scripts/pomodoro.check.ts
import assert from "node:assert/strict";
import { advance, initial, pause, remaining, reset, resize, start, tick, type Config } from "../src/pomodoro.ts";

const cfg: Config = { focus: 25, short: 5, long: 15, every: 2, auto: false };
const M = 60_000;
const t0 = new Date(2026, 10, 19, 10, 0).getTime();

let p = initial(cfg, t0);
assert.equal(remaining(p, t0), 25 * M);
assert.equal(tick(p, cfg, t0 + 99 * M).finished, null); // not running: never finishes

// run, pause, resume: paused time doesn't count
p = start(p, t0);
p = pause(p, t0 + 10 * M);
assert.equal(remaining(p, t0 + 50 * M), 15 * M);
p = start(p, t0 + 50 * M);
assert.equal(tick(p, cfg, t0 + 64 * M).finished, null);

// focus ends -> short break, waiting for a start (auto off)
let r = tick(p, cfg, t0 + 65 * M);
assert.equal(r.finished, "focus");
assert.deepEqual([r.next.phase, r.next.round, r.next.done, r.next.end], ["short", 1, 1, null]);

// skipping the break goes back to focus; skipping a focus round doesn't count it
p = advance(r.next, cfg, t0 + 66 * M, false);
assert.equal(p.phase, "focus");
const skipped = advance(p, cfg, t0 + 66 * M, false);
assert.deepEqual([skipped.phase, skipped.round, skipped.done], ["short", 1, 1]);

// second finished round -> long break; after it the cycle starts over
r = tick(start(p, t0 + 66 * M), cfg, t0 + 91 * M);
assert.deepEqual([r.next.phase, r.next.round, r.next.done, r.next.left], ["long", 2, 2, 15 * M]);
p = advance(r.next, cfg, t0 + 106 * M, true);
assert.deepEqual([p.phase, p.round, p.done], ["focus", 0, 2]);

// auto-start runs the next phase straight away, but not after a skip
const auto = { ...cfg, auto: true };
r = tick(start(initial(auto, t0), t0), auto, t0 + 25 * M);
assert.equal(r.next.end, t0 + 30 * M);
assert.equal(advance(start(initial(auto, t0), t0), auto, t0, false).end, null);

// the daily count starts over on a new day; reset keeps today's
const tomorrow = t0 + 24 * 60 * M;
assert.equal(tick(start({ ...p, done: 5 }, tomorrow), cfg, tomorrow + 25 * M).next.done, 1);
assert.deepEqual([reset({ ...p, done: 5 }, cfg, t0).done, reset({ ...p, done: 5 }, cfg, tomorrow).done], [5, 0]);

// a changed length applies to a phase that hasn't started, and leaves a paused one alone
const longer = { ...cfg, focus: 50 };
assert.equal(resize(initial(cfg, t0), cfg, longer).left, 50 * M);
const paused = pause(start(initial(cfg, t0), t0), t0 + M);
assert.equal(resize(paused, cfg, longer).left, 24 * M);

console.log("pomodoro checks passed");
