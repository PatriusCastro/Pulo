export type Line = { t: number; text: string }; // t = ms from the start of the track

/** Parse LRC ("[01:23.45] words"), sorted by time. Lines can carry several timestamps. */
export function parseLrc(lrc: string): Line[] {
  const out: Line[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) out.push({ t: Math.round((+m[1] * 60 + +m[2]) * 1000), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Index of the line being sung at `ms`, or -1 before the first line. */
export function lineAt(lines: Line[], ms: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= ms) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
