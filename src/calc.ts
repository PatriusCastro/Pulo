// The island's calculator. Pure, so scripts/calc.check.ts can check it.
// The sum is kept as text: numbers (a leading "-" for a negative one) and the operators
// + − × ÷ (the real minus sign, so it can't be mistaken for a negative number).

export type Calc = { expr: string; done: boolean }; // done: "=" was just pressed
export const EMPTY: Calc = { expr: "", done: false };
export const OPS = ["+", "−", "×", "÷"];

const lastNum = /-?[\d.]+$/;
const fmt = (v: number) => String(Number(v.toPrecision(12)));

/** The value of a sum, × and ÷ before + and −. A trailing operator is ignored, so it works as
 *  a preview while typing. null for nothing to show or dividing by zero. */
export function evaluate(expr: string): number | null {
  const parts = expr.replace(/[+−×÷]$/, "").match(/-?[\d.]+|[+−×÷]/g);
  if (!parts?.length) return null;
  const nums: number[] = [];
  const ops: string[] = [];
  for (const p of parts) {
    if (OPS.includes(p)) ops.push(p);
    else {
      let n = parseFloat(p);
      if (Number.isNaN(n)) return null;
      const op = ops[ops.length - 1];
      if (op === "×" || op === "÷") {
        ops.pop();
        const a = nums.pop()!;
        if (op === "÷" && n === 0) return null;
        n = op === "×" ? a * n : a / n;
      }
      nums.push(n);
    }
  }
  return nums.reduce((acc, n, i) => (i === 0 ? n : ops[i - 1] === "+" ? acc + n : acc - n), 0);
}

export function press(c: Calc, key: string): Calc {
  const { expr, done } = c;
  if (key === "C") return EMPTY;
  if (key === "⌫") return done ? EMPTY : { expr: expr.slice(0, -1), done: false };
  if (key === "=") {
    const v = evaluate(expr);
    return v === null ? c : { expr: fmt(v), done: true };
  }
  if (OPS.includes(key)) {
    if (!expr) return { expr: `0${key}`, done: false };
    return { expr: OPS.includes(expr[expr.length - 1]) ? expr.slice(0, -1) + key : expr + key, done: false };
  }
  const num = expr.match(lastNum)?.[0];
  if (key === "±" || key === "%") {
    if (!num) return c;
    const n = key === "±" ? (num.startsWith("-") ? num.slice(1) : `-${num}`) : fmt(parseFloat(num) / 100);
    return { expr: expr.slice(0, -num.length) + n, done: false };
  }
  // A digit or the point. After "=", a new number starts a new sum.
  const base = done ? "" : expr;
  const cur = done ? undefined : num;
  if (key === ".") return { expr: cur?.includes(".") ? base : base + (cur ? "." : "0."), done: false };
  if (cur === "0" || cur === "-0") return { expr: base.slice(0, -1) + key, done: false }; // no leading zeros
  return { expr: base + key, done: false };
}

/** For the display: thousands separators in each number's whole part. */
export const pretty = (expr: string) => expr.replace(/\d+/g, (d, i: number) => (expr[i - 1] === "." ? d : d.replace(/\B(?=(\d{3})+(?!\d))/g, ",")));
