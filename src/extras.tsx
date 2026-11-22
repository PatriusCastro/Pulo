// Island extras: equalizer bars, lyrics, the position bar, and the pet.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { lineAt, type Line } from "./lyrics";

/** Live bars. Mount only while visible: capture runs exactly as long as this is mounted.
 *  Updates the DOM directly so frames don't re-render React. `fps` is how often Rust sends
 *  levels: every update costs this window CPU, so the always-visible collapsed pill uses a
 *  lower rate than the open panel. */
export function Equalizer({ className = "eq", fps = 30 }: { className?: string; fps?: number }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    invoke("equalizer", { on: true, fps }); // Rust sends at this rate
    const un = listen<number[]>("eq", (e) => {
      e.payload.forEach((v, i) => {
        const b = bars.current[i];
        if (b) b.style.transform = `scaleY(${0.12 + v * 0.88})`;
      });
    });
    return () => {
      invoke("equalizer", { on: false });
      un.then((f) => f());
    };
  }, [fps]);
  return (
    <div className={className} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} ref={(el) => void (bars.current[i] = el)} />
      ))}
    </div>
  );
}

/** Index of the lyric line at the current playback position. Checks 4x a second while
 *  playing, but React only re-renders when the line actually changes. */
export function useLyricIndex(lines: Line[], positionMs: number, positionAt: number, playing: boolean) {
  const [i, setI] = useState(-1);
  useEffect(() => {
    const tick = () => setI(lineAt(lines, positionMs + (playing && positionAt ? Date.now() - positionAt : 0)));
    tick();
    if (!playing || !lines.length) return;
    const id = window.setInterval(tick, 250);
    return () => clearInterval(id);
  }, [lines, positionMs, positionAt, playing]);
  return i;
}

/** Big lyrics, the way music apps show them: whole lines that wrap, the one being sung bright,
 *  the rest dim, scrolled so the line before it shows whole at the top. One transition per
 *  line change, nothing looping. Clicking a line jumps there when `onSeek` is given. */
export function LyricsPanel({ lines, i, onSeek }: { lines: Line[]; i: number; onSeek?: (ms: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const [y, setY] = useState(0);
  useLayoutEffect(() => {
    const box = list.current;
    const el = box?.children[Math.max(0, i - 1)] as HTMLElement | undefined;
    if (el) setY(el.offsetTop);
  }, [i, lines]);
  return (
    <div className="lyrics-panel" aria-label="Lyrics">
      <div ref={list} className="lyrics-scroll" style={{ transform: `translateY(${-y}px)` }}>
        {lines.map((l, k) => (
          <button
            key={k}
            className={`lyric${k === i ? " now" : k < i ? " past" : ""}`}
            aria-current={k === i || undefined}
            tabIndex={onSeek ? 0 : -1}
            disabled={!onSeek}
            onClick={() => onSeek?.(l.t)}
          >
            {l.text || "♪"}
          </button>
        ))}
      </div>
    </div>
  );
}

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Position bar with times. Ticks on its own once a second while playing, so the rest of
 *  the island doesn't re-render. Dragging seeks when released. */
export function Progress({
  duration,
  position,
  at,
  playing,
  canSeek,
  onSeek,
}: {
  duration: number;
  position: number;
  at: number;
  playing: boolean;
  canSeek: boolean;
  onSeek: (ms: number) => void;
}) {
  const [, tick] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [playing]);
  if (duration <= 0) return null;
  const live = Math.min(duration, position + (playing && at ? Date.now() - at : 0));
  const pos = drag ?? live;
  const commit = () => {
    if (drag !== null) onSeek(drag);
    setDrag(null);
  };
  return (
    <div className="progress-row">
      <span className="time mono">{fmtTime(pos)}</span>
      <input
        type="range"
        className="slider"
        min={0}
        max={duration}
        step={1000}
        value={pos}
        disabled={!canSeek}
        aria-label="Position"
        aria-valuetext={`${fmtTime(pos)} of ${fmtTime(duration)}`}
        style={{ "--pct": `${(pos / duration) * 100}%` } as React.CSSProperties}
        onChange={(e) => setDrag(+e.target.value)}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => setDrag(null)}
      />
      <span className="time mono">{fmtTime(duration)}</span>
    </div>
  );
}

export type Mood = "idle" | "sleep" | "work" | "happy";

/** Pulo's pet: a small island sprout. Static except a blink every few seconds and a short
 *  hop when happy, because a looping animation costs ~30% of a core in this window. */
export function Pet({ mood }: { mood: Mood }) {
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (mood === "sleep" || mood === "happy") return;
    let t: number;
    const loop = () => {
      t = window.setTimeout(() => {
        setBlink(true);
        t = window.setTimeout(() => {
          setBlink(false);
          loop();
        }, 140);
      }, 4000 + Math.random() * 4000);
    };
    loop();
    return () => clearTimeout(t);
  }, [mood]);

  const body = mood === "work" ? "#ff9f43" : "#3ddc84";
  const eyesClosed = mood === "sleep" || blink;
  return (
    <svg className={`pet ${mood}`} width="24" height="24" viewBox="0 1.5 24 24" role="img" aria-label={`Pet is ${mood === "idle" ? "awake" : mood === "work" ? "watching an agent" : mood === "sleep" ? "napping" : "happy"}`}>
      <path d="M12 9c0-3 2-5 5-5-1 3-2.5 4.5-5 5zm0 0c-.5-2.5-2.5-4-5-4 1 2.5 2.5 3.5 5 4z" fill={body} opacity=".8" />
      <ellipse cx="12" cy="15.5" rx="9" ry="6.5" fill={body} />
      {mood === "happy" ? (
        <path d="M7.5 15.5l1.5-1.5 1.5 1.5M13.5 15.5l1.5-1.5 1.5 1.5" stroke="#000" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      ) : eyesClosed ? (
        <path d="M7.5 15h3M13.5 15h3" stroke="#000" strokeWidth="1.4" strokeLinecap="round" />
      ) : (
        <g fill="#000">
          <circle cx={mood === "work" ? 10 : 9} cy="15" r="1.4" />
          <circle cx={mood === "work" ? 16 : 15} cy="15" r="1.4" />
        </g>
      )}
      {mood === "sleep" && (
        <text x="18" y="7" fontSize="7" fill="#f5f5f5" fontWeight="700">
          z
        </text>
      )}
    </svg>
  );
}
