// Phase 3 extras: equalizer bars, the synced lyric line, and the pet.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { lineAt, type Line } from "./lyrics";

/** Live bars. Mount only while visible: capture runs exactly as long as this is mounted.
 *  Updates the DOM directly so 30 frames a second don't re-render React. */
export function Equalizer() {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    invoke("equalizer", { on: true });
    const un = listen<number[]>("eq", (e) =>
      e.payload.forEach((v, i) => {
        const b = bars.current[i];
        if (b) b.style.transform = `scaleY(${0.12 + v * 0.88})`;
      }),
    );
    return () => {
      invoke("equalizer", { on: false });
      un.then((f) => f());
    };
  }, []);
  return (
    <div className="eq" aria-hidden="true">
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

/** Previous, current and next line; the current one highlighted. */
export function LyricLines({ lines, i }: { lines: Line[]; i: number }) {
  const at = (k: number) => (k >= 0 && k < lines.length ? lines[k].text || "♪" : "");
  return (
    <div className="lyrics" key={i} aria-live="off">
      <div className="lyric dim">{at(i - 1)}</div>
      <div className="lyric now">{i >= 0 ? at(i) : "♪"}</div>
      <div className="lyric dim">{at(i + 1)}</div>
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
    <svg className={`pet ${mood}`} width="24" height="24" viewBox="0 0 24 24" role="img" aria-label={`Pet is ${mood === "idle" ? "awake" : mood === "work" ? "watching an agent" : mood === "sleep" ? "napping" : "happy"}`}>
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
