// Run: node --experimental-strip-types scripts/calc.check.ts
import assert from "node:assert/strict";
import { EMPTY, evaluate, press, pretty, type Calc } from "../src/calc.ts";

const keys = (s: string[], c: Calc = EMPTY) => s.reduce(press, c);

// precedence, and a trailing operator ignored in the preview
assert.equal(evaluate("2+3×4"), 14);
assert.equal(evaluate("10−4÷2+1"), 9);
assert.equal(evaluate("6×"), 6);
assert.equal(evaluate("5÷0"), null);
assert.equal(evaluate(""), null);

// typing: an operator replaces the one before it; no leading zeros; one point per number
assert.equal(keys(["1", "+", "×", "2"]).expr, "1×2");
assert.equal(keys(["0", "0", "7"]).expr, "7");
assert.equal(keys([".", "5", ".", "2"]).expr, "0.52");
assert.equal(keys(["+"]).expr, "0+");

// =, then a digit starts over and an operator carries on
const eq = keys(["0", ".", "1", "+", "0", ".", "2", "="]);
assert.deepEqual(eq, { expr: "0.3", done: true }); // no 0.30000000000000004
assert.equal(press(eq, "4").expr, "4");
assert.equal(press(eq, "×").expr, "0.3×");

// ± and % act on the last number; a negative number is still read as one
assert.equal(keys(["8", "−", "3", "±"]).expr, "8−-3");
assert.equal(evaluate("8−-3"), 11);
assert.equal(keys(["5", "0", "%"]).expr, "0.5");
assert.equal(keys(["9", "⌫", "C"]).expr, "");

assert.equal(pretty("1234567.8901×1000"), "1,234,567.8901×1,000");

console.log("calc checks passed");
