// Run: node --experimental-strip-types scripts/lyrics.check.ts
import assert from "node:assert/strict";
import { lineAt, parseLrc } from "../src/lyrics.ts";

const lines = parseLrc("[ar:Someone]\r\n[00:01.50] First\n[00:10.00][01:00.00] Chorus\n[00:05.25]Second\nno stamp\n[00:20.00]");
assert.deepEqual(lines, [
  { t: 1500, text: "First" },
  { t: 5250, text: "Second" },
  { t: 10000, text: "Chorus" },
  { t: 20000, text: "" },
  { t: 60000, text: "Chorus" },
]);
assert.equal(lineAt(lines, 0), -1);
assert.equal(lineAt(lines, 1500), 0);
assert.equal(lineAt(lines, 9999), 1);
assert.equal(lineAt(lines, 30000), 3);
assert.equal(lineAt(lines, 999999), 4);
assert.equal(lineAt([], 5), -1);
console.log("lyrics checks passed");
