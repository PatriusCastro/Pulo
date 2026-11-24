// Pomodoro state machine. Pure: every function takes the current time, so it can be checked
// without a clock (scripts/pomodoro.check.ts).

export type Phase = "focus" | "short" | "long";
/** Lengths in minutes; a long break follows every `every` finished focus rounds. */
export type Config = { focus: number; short: number; long: number; every: number; auto: boolean };
export type Pomo = {
  phase: Phase;
  round: number; // focus rounds finished since the last long break
  end: number | null; // ms since epoch while running; a timestamp, so sleep and restarts don't drift
  left: number; // ms left while paused or not started
  done: number; // focus rounds finished on `day`
  day: string;
};

export const DEFAULTS: Config = { focus: 25, short: 5, long: 15, every: 4, auto: false };
export const LABEL: Record<Phase, string> = { focus: "Focus", short: "Break", long: "Long break" };

const dayKey = (now: number) => new Date(now).toDateString();
export const length = (phase: Phase, cfg: Config) => cfg[phase] * 60_000;

export const initial = (cfg: Config, now: number): Pomo => ({
  phase: "focus",
  round: 0,
  end: null,
  left: length("focus", cfg),
  done: 0,
  day: dayKey(now),
});

/** Anything that counts down: a pomodoro phase, and the Focus tab's plain timer. */
export type Countdown = { end: number | null; left: number };
export const remaining = (p: Countdown, now: number) => (p.end === null ? p.left : Math.max(0, p.end - now));
export const start = <T extends Countdown>(p: T, now: number): T => (p.end === null ? { ...p, end: now + p.left } : p);
export const pause = <T extends Countdown>(p: T, now: number): T => (p.end === null ? p : { ...p, left: remaining(p, now), end: null });

/** Move to the next phase. `completed` is false for a skip: a skipped focus round isn't counted. */
export function advance(p: Pomo, cfg: Config, now: number, completed: boolean): Pomo {
  const day = dayKey(now);
  let { round } = p;
  let done = p.day === day ? p.done : 0;
  let phase: Phase = "focus";
  if (p.phase === "focus") {
    if (completed) {
      round++;
      done++;
    }
    phase = completed && round >= cfg.every ? "long" : "short";
  } else if (p.phase === "long") round = 0;
  const left = length(phase, cfg);
  return { phase, round, done, day, left, end: cfg.auto && completed ? now + left : null };
}

/** Call about once a second while running. `finished` is the phase that just ended, if any. */
export function tick(p: Pomo, cfg: Config, now: number): { next: Pomo; finished: Phase | null } {
  if (p.end === null || now < p.end) return { next: p, finished: null };
  return { next: advance(p, cfg, now, true), finished: p.phase };
}

/** Back to a fresh focus round; today's count is kept. */
export const reset = (p: Pomo, cfg: Config, now: number): Pomo => ({ ...initial(cfg, now), done: p.day === dayKey(now) ? p.done : 0 });

/** A phase that hasn't been started follows a changed length setting. */
export const resize = (p: Pomo, old: Config, cfg: Config): Pomo =>
  p.end === null && p.left === length(p.phase, old) ? { ...p, left: length(p.phase, cfg) } : p;

/** Jump to a spot in the cycle (a phase and the focus rounds finished before it), stopped at
 *  its full length. Today's count is kept. */
export const jump = (p: Pomo, phase: Phase, round: number, cfg: Config): Pomo => ({ ...p, phase, round, end: null, left: length(phase, cfg) });
