// Run: node --experimental-strip-types scripts/whatsnew.check.ts
import assert from "node:assert/strict";
import { NOTES, newer, notesSince } from "../src/whatsnew.ts";

assert.equal(newer("0.1.10", "0.1.9"), true);
assert.equal(newer("0.2", "0.1.9"), true);
assert.equal(newer("0.1.5", "0.1.5"), false);
assert.equal(newer("0.1.4", "0.1.5"), false);

// Notes after what you last saw, up to what's running; never a version still unreleased.
const latest = NOTES[0][0];
assert.deepEqual(notesSince("0.0.1", latest)[0][0], latest);
assert.equal(notesSince(latest, latest).length, 0);
assert.equal(notesSince("0.0.1", "0.0.2").length, 0);

// Newest first, so the page reads top down.
for (let i = 1; i < NOTES.length; i++) assert.ok(newer(NOTES[i - 1][0], NOTES[i][0]), `${NOTES[i - 1][0]} before ${NOTES[i][0]}`);

console.log("whatsnew checks passed");
