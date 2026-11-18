import { useEffect, useMemo, useRef, useState } from "react";
import { occurrences, parseIcs, type Raw } from "./ics";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./island.css";

type Media = { title: string; artist: string; playing: boolean; art_rev: number };
type Snapshot = { media: Media | null; battery: { percent: number; charging: boolean } | null };
type Hud = { kind: "volume" | "brightness" | "power" | "timer" | "download"; level: number; flag: boolean; text?: string };

// Must match .pill / .pill.open in island.css.
const COLLAPSED = { w: 200, h: 36 };
const EXPANDED = { w: 420, h: 236 }; // also MAX in lib.rs
const PRESETS = [1, 5, 15, 25];

const ICONS = {
  prev: "M6 6h2v12H6zm3.5 6 8.5 6V6z",
  next: "M16 6h2v12h-2zm-10 12 8.5-6L6 6z",
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zm8 0h4v14h-4z",
  volume: "M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4",
  mute: "M3 9v6h4l5 5V4L7 9zm16.6 3 2.1-2.1-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4z",
  brightness:
    "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zm12.1-12.1 2.1-2.1 1.4 1.4-2.1 2.1z",
  power: "M11 21h-1l1-7H7.5c-.6 0-.6-.3-.4-.6L13 3h1l-1 7h3.5c.5 0 .6.3.4.6z",
  battery: "M16 4h-2V2h-4v2H8a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z",
  timer:
    "M15 1H9v2h6zm-4 13h2V8h-2zm8-6.6 1.4-1.4-1.4-1.4-1.4 1.4A9 9 0 1 0 21 13a9 9 0 0 0-2-5.6zM12 20a7 7 0 1 1 0-14 7 7 0 0 1 0 14z",
  shelf: "M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3z",
  download: "M5 20h14v-2H5zM19 9h-4V3H9v6H5l7 7z",
  close: "M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z",
};

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d={d} />
  </svg>
);

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const fileName = (p: string) => p.split(/[\\/]/).pop() || p;
const fileExt = (p: string) => {
  const n = fileName(p);
  return n.includes(".") ? n.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE";
};

function loadShelf(): string[] {
  try {
    return JSON.parse(localStorage.getItem("shelf") || "[]");
  } catch {
    return [];
  }
}

function saveShelf(paths: string[]) {
  try {
    localStorage.setItem("shelf", JSON.stringify(paths));
  } catch {}
  return paths;
}

function chime(ctx: AudioContext) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = 880;
  g.gain.setValueAtTime(0.2, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);
  o.connect(g).connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 1.2);
}

export default function App() {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<Snapshot>({ media: null, battery: null });
  const [art, setArt] = useState<string | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [timerEnd, setTimerEnd] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const leave = useRef<number | undefined>(undefined);
  const hudTimer = useRef<number | undefined>(undefined);
  const audio = useRef<AudioContext | null>(null);
  const [shelf, setShelf] = useState<string[]>(loadShelf);
  const [events, setEvents] = useState<Raw[]>([]);
  const dragStart = useRef<{ x: number; y: number; path: string } | null>(null);

  // Newest first, no duplicates, kept across restarts.
  const addToShelf = (paths: string[]) =>
    setShelf((cur) => saveShelf([...paths, ...cur.filter((p) => !paths.includes(p))].slice(0, 30)));
  const removeFromShelf = (path: string) => setShelf((cur) => saveShelf(cur.filter((p) => p !== path)));

  const showHud = (h: Hud, ms = 1600) => {
    setHud(h);
    clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setHud(null), ms);
  };

  // System state from Rust: initial snapshot, then push updates.
  useEffect(() => {
    invoke<Snapshot>("snapshot").then(setSnap);
    invoke<string>("calendar").then((t) => setEvents(parseIcs(t)));
    const un = [
      listen<Snapshot>("state", (e) => setSnap(e.payload)),
      listen<[Hud["kind"], number, boolean]>("hud", (e) => {
        const [kind, level, flag] = e.payload;
        showHud({ kind, level, flag });
      }),
      listen<string>("calendar", (e) => setEvents(parseIcs(e.payload))),
      listen<string>("download", (e) => {
        addToShelf([e.payload]);
        showHud({ kind: "download", level: 1, flag: false, text: fileName(e.payload) }, 4000);
      }),
      // Files dragged onto the pill: open it while hovering, add them to the shelf on drop.
      getCurrentWebview().onDragDropEvent((e) => {
        const t = e.payload.type;
        if (t === "enter") expand();
        else if (t === "drop") {
          addToShelf(e.payload.paths);
          collapseSoon(1500); // no mouse events fire during a drag; the next mouseenter cancels this
        } else if (t === "leave") collapseSoon(150);
      }),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);

  // Album art: refetch raw bytes whenever Rust bumps art_rev.
  const artRev = snap.media?.art_rev;
  useEffect(() => {
    if (!artRev) return setArt(null);
    let url: string | null = null;
    invoke<ArrayBuffer>("media_art").then((buf) => {
      url = buf.byteLength ? URL.createObjectURL(new Blob([buf])) : null;
      setArt(url);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [artRev]);

  // Clock: one update per minute, aligned to the minute boundary.
  useEffect(() => {
    let id: number;
    const tick = () => {
      setNow(Date.now());
      id = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    tick();
    return () => clearTimeout(id);
  }, []);

  // Timer: ticks only while one is running.
  useEffect(() => {
    if (!timerEnd) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= timerEnd) {
        setTimerEnd(null);
        if (audio.current) chime(audio.current);
        showHud({ kind: "timer", level: 1, flag: false }, 6000);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [timerEnd]);

  const startTimer = (min: number) => {
    audio.current ??= new AudioContext(); // created on a click so the chime may play later
    setNow(Date.now());
    setTimerEnd(Date.now() + min * 60_000);
  };

  // Expand: grow the window region first, then animate the pill into it.
  function expand() {
    clearTimeout(leave.current);
    invoke("resize", EXPANDED).then(() => setOpen(true));
  }
  // Collapse: animate the pill down; the region shrinks once the animation ends.
  function collapseSoon(ms: number) {
    clearTimeout(leave.current);
    leave.current = window.setTimeout(() => setOpen(false), ms);
  }
  const onEnter = () => (open ? clearTimeout(leave.current) : expand());
  const onLeave = () => collapseSoon(150);

  // Shelf items: click opens, press-and-move drags the file out like Explorer does.
  const onItemMove = (e: React.MouseEvent) => {
    const d = dragStart.current;
    if (!d || !(e.buttons & 1) || Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    dragStart.current = null;
    invoke("drag_out", { paths: [d.path] });
  };
  const onTransitionEnd = (e: React.TransitionEvent) => {
    if (!open && e.target === e.currentTarget && e.propertyName === "width") invoke("resize", COLLAPSED);
  };

  const { media, battery } = snap;
  const remaining = timerEnd ? fmt(timerEnd - now) : null;
  const date = new Date(now);
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const clock = hm(now);
  const playing = !!media?.playing;

  // Next timed event that hasn't ended, looking up to 36 hours ahead. Recomputed each minute.
  const next = useMemo(
    () => occurrences(events, now, now + 36 * 3_600_000).find((o) => !o.allDay && o.end > now) ?? null,
    [events, now],
  );
  const minsUntil = next ? Math.ceil((next.start - now) / 60_000) : Infinity;
  // Collapsed pill shows the event from 15 minutes before until 5 minutes after it starts.
  const soon = next && minsUntil <= 15 && minsUntil > -5 ? `${next.title} · ${minsUntil > 0 ? `${minsUntil}m` : "now"}` : null;
  const when = (t: number) =>
    t <= now ? "Now" : (new Date(t).getDate() === date.getDate() ? "" : "Tomorrow ") + hm(t);
  const nextLabel = next ? `${when(next.start)} · ${next.title}` : null;

  // Both layers are always rendered at their own fixed size and crossfade, so nothing
  // reflows while the pill changes shape.
  return (
    <div
      className={`pill${open ? " open" : ""}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onTransitionEnd={onTransitionEnd}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="layer mini-layer" aria-hidden={open}>
        {hud ? (
          <div className="hud">
            {hud.kind === "download" ? (
              <>
                <Icon d={ICONS.download} />
                <span className="hud-text">{hud.text}</span>
              </>
            ) : hud.kind === "timer" ? (
              <>
                <Icon d={ICONS.timer} />
                <span>Timer done</span>
              </>
            ) : hud.kind === "power" ? (
              <>
                <Icon d={hud.flag ? ICONS.power : ICONS.battery} />
                <span>
                  {hud.flag ? "Charging" : "On battery"} · {Math.round(hud.level * 100)}%
                </span>
              </>
            ) : (
              <>
                <Icon d={hud.kind === "brightness" ? ICONS.brightness : hud.flag ? ICONS.mute : ICONS.volume} />
                <div className="meter">
                  <div style={{ width: `${hud.flag ? 0 : hud.level * 100}%` }} />
                </div>
                <span className="mono pct">{hud.flag ? "Muted" : Math.round(hud.level * 100)}</span>
              </>
            )}
          </div>
        ) : (
          <div className="mini">
            <span className="slot">{playing && art && <img className="mini-art" src={art} alt="" />}</span>
            <span className={`mono center${remaining || soon ? " accent" : ""}`}>{remaining ?? soon ?? clock}</span>
            <span className="slot">{playing ? <Icon d={ICONS.play} size={14} /> : <span className="dot" />}</span>
          </div>
        )}
      </div>

      <div className="layer panel" aria-hidden={!open}>
        {media ? (
          <div className="media">
            {art ? <img className="art" src={art} alt="" /> : <div className="art empty" />}
            <div className="meta">
              <div className="title">{media.title || "Unknown title"}</div>
              <div className="sub">{media.artist}</div>
            </div>
            <div className="controls">
              <button aria-label="Previous" onClick={() => invoke("media", { action: "prev" })}>
                <Icon d={ICONS.prev} size={20} />
              </button>
              <button
                aria-label={media.playing ? "Pause" : "Play"}
                onClick={() => invoke("media", { action: "toggle" })}
              >
                <Icon d={media.playing ? ICONS.pause : ICONS.play} size={26} />
              </button>
              <button aria-label="Next" onClick={() => invoke("media", { action: "next" })}>
                <Icon d={ICONS.next} size={20} />
              </button>
            </div>
          </div>
        ) : (
          <div className="idle">
            <div className="big-clock mono">{clock}</div>
            <div className="sub">{date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
            {nextLabel && <div className="next-event">{nextLabel}</div>}
          </div>
        )}
        <div className="shelf" onMouseMove={onItemMove} onMouseUp={() => (dragStart.current = null)}>
          {shelf.length ? (
            shelf.map((p) => (
              <div
                key={p}
                className="item"
                title={p}
                onMouseDown={(e) => {
                  if (e.button === 0) dragStart.current = { x: e.clientX, y: e.clientY, path: p };
                }}
                onClick={() => invoke("open_path", { path: p })}
              >
                <span className="ext">{fileExt(p)}</span>
                <span className="name">{fileName(p)}</span>
                <button
                  className="remove"
                  aria-label={`Remove ${fileName(p)}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFromShelf(p);
                  }}
                >
                  <Icon d={ICONS.close} size={12} />
                </button>
              </div>
            ))
          ) : (
            <div className="shelf-empty">
              <Icon d={ICONS.shelf} size={16} />
              Drop files on the island to keep them here
            </div>
          )}
        </div>
        <div className="bar">
          {battery && (
            <span className={`batt${battery.charging ? " charging" : ""}`}>
              <Icon d={battery.charging ? ICONS.power : ICONS.battery} size={14} />
              {battery.percent}%
            </span>
          )}
          <div className="timer">
            <Icon d={ICONS.timer} size={14} />
            {remaining ? (
              <>
                <span className="mono">{remaining}</span>
                <button aria-label="Cancel timer" onClick={() => setTimerEnd(null)}>
                  <Icon d={ICONS.close} size={14} />
                </button>
              </>
            ) : (
              PRESETS.map((m) => (
                <button key={m} className="chip" onClick={() => startTimer(m)}>
                  {m}m
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
