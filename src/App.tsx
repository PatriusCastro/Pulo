import { useEffect, useMemo, useRef, useState } from "react";
import { occurrences, parseIcs, type Raw } from "./ics";
import { parseLrc, type Line } from "./lyrics";
import { Equalizer, LyricLines, Pet, useLyricIndex, type Mood } from "./extras";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./island.css";

type Device = { name: string; percent: number; kind: string };
type Media = {
  title: string;
  artist: string;
  playing: boolean;
  art_rev: number;
  duration_ms: number;
  position_ms: number;
  position_at: number;
};
type Snapshot = { media: Media | null; battery: { percent: number; charging: boolean } | null };
type Agents = {
  sessions: { agent: string; title: string; project: string; working: boolean; last: number }[];
  tokens_today: number;
};
type Hud = {
  kind: "volume" | "brightness" | "power" | "timer" | "download" | "agent" | "notification" | "device";
  level: number;
  flag: boolean;
  text?: string;
  icon?: string; // device HUD: the device-type icon path
};

// Must match .pill / .pill.open in island.css.
const COLLAPSED = { w: 200, h: 36 };
const COLLAPSED_LYRICS = { w: 340, h: 36 }; // also .pill.wide in island.css
const EXPANDED = { w: 516, h: 268 }; // open pill + shortcut columns; also MAX in lib.rs
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
  mixer: "M7 3h2v6h2v2H5V9h2zm0 10h2v8H7zm8-10h2v10h2v2h-6v-2h2zm0 14h2v4h-2z",
  timer:
    "M15 1H9v2h6zm-4 13h2V8h-2zm8-6.6 1.4-1.4-1.4-1.4-1.4 1.4A9 9 0 1 0 21 13a9 9 0 0 0-2-5.6zM12 20a7 7 0 1 1 0-14 7 7 0 0 1 0 14z",
  shelf: "M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3z",
  agent: "M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z",
  bell: "M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-5-5.9V4h-2v1.1A6 6 0 0 0 6 11v5l-2 2v1h16v-1z",
  download: "M5 20h14v-2H5zM19 9h-4V3H9v6H5l7 7z",
  close: "M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z",
  mouse: "M12 2a6 6 0 0 0-6 6v8a6 6 0 0 0 12 0V8a6 6 0 0 0-6-6zm-1 3h2v4h-2z",
  keyboard: "M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm2 3v2h2V9zm4 0v2h2V9zm4 0v2h2V9zm4 0v2h2V9zM7 13v2h10v-2z",
  headphones: "M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z",
  bluetooth: "M11 2h1l6 5.5-4.6 4.5 4.6 4.5-6 5.5h-1v-7.6l-4.3 4.2-1.4-1.4 5.7-5.2-5.7-5.2 1.4-1.4 4.3 4.2zm2 2.5v5l2.7-2.5zm0 10v5l2.7-2.5z",
  gear: "M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.47.41l-.36 2.54a7.4 7.4 0 0 0-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z",
  activity: "M3 11h4.3L10 3.6l4 13.2 2.4-5.8H21v2h-3.3L14 21.4 10 8.2 8.7 13H3z",
  calculator: "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 3v4h10V5zm0 7v2h2v-2zm4 0v2h2v-2zm4 0v2h2v-2zm-8 4v2h2v-2zm4 0v2h2v-2zm4 0v2h2v-2z",
  screenshot: "M7 3h2v4h8a2 2 0 0 1 2 2v8h3v2h-3v3h-2v-3H9a2 2 0 0 1-2-2V9H4V7h3zm2 6v8h8V9z",
  clipboard: "M9 2h6a1 1 0 0 1 1 1v1h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V3a1 1 0 0 1 1-1zm1 2v2h4V4zM8 10v2h8v-2zm0 4v2h6v-2z",
  folder: "M3 6a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
};
const DEVICE_ICON: Record<string, string> = { mouse: ICONS.mouse, keyboard: ICONS.keyboard, headphones: ICONS.headphones };

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d={d} fillRule="evenodd" />
  </svg>
);

const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
// A session still marked working after 10 quiet minutes was most likely closed mid-turn.
const STALE_MS = 10 * 60_000;

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
  const [agents, setAgents] = useState<Agents>({ sessions: [], tokens_today: 0 });
  const [devices, setDevices] = useState<Device[]>([]);
  // Play/pause shown right after a click, until the player reports back.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const optimisticTimer = useRef<number | undefined>(undefined);
  const dragStart = useRef<{ x: number; y: number; path: string } | null>(null);
  const [lyricsOn, setLyricsOn] = useState(false);
  const [lyrics, setLyrics] = useState<Line[]>([]);
  const lyricsCache = useRef(new Map<string, Line[]>());
  const [away, setAway] = useState(false);
  const [cheerUntil, setCheerUntil] = useState(0);
  const cheer = () => setCheerUntil(Date.now() + 12_000);

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
    invoke<Agents>("agents").then(setAgents);
    invoke<Device[]>("devices").then(setDevices);
    invoke<{ lyrics: boolean }>("get_settings").then((s) => setLyricsOn(s.lyrics));
    const un = [
      listen<Snapshot>("state", (e) => setSnap(e.payload)),
      listen<[Hud["kind"], number, boolean]>("hud", (e) => {
        const [kind, level, flag] = e.payload;
        showHud({ kind, level, flag });
      }),
      listen<string>("calendar", (e) => setEvents(parseIcs(e.payload))),
      listen<Agents>("agents", (e) => setAgents(e.payload)),
      listen<[string, string]>("agent_done", (e) => {
        cheer();
        showHud({ kind: "agent", level: 1, flag: false, text: `Claude finished · ${e.payload[0]}` }, 8000);
      }),
      listen<boolean>("lyrics_enabled", (e) => setLyricsOn(e.payload)),
      listen<boolean>("away", (e) => setAway(e.payload)),
      listen<Device[]>("devices", (e) => setDevices(e.payload)),
      listen<Device>("device_connected", (e) =>
        showHud({ kind: "device", level: e.payload.percent / 100, flag: false, text: `${e.payload.percent}%`, icon: DEVICE_ICON[e.payload.kind] }, 4000),
      ),
      listen<Device>("device_low", (e) =>
        showHud({ kind: "device", level: e.payload.percent / 100, flag: true, text: `Low · ${e.payload.percent}%`, icon: DEVICE_ICON[e.payload.kind] }, 6000),
      ),
      listen<[string, string, string]>("notification", (e) => {
        const [app, title] = e.payload;
        showHud({ kind: "notification", level: 1, flag: false, text: [app, title].filter(Boolean).join(" · ") }, 5000);
      }),
      listen<string>("download", (e) => {
        cheer();
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

  // When a track starts (or playback resumes), show its title in the pill for a few seconds.
  const [songFlash, setSongFlash] = useState<string | null>(null);
  const songTitle = snap.media?.playing ? snap.media.title : "";
  useEffect(() => {
    if (!songTitle) return setSongFlash(null);
    setSongFlash(songTitle);
    const id = window.setTimeout(() => setSongFlash(null), 4000);
    return () => clearTimeout(id);
  }, [songTitle]);

  // End the pet's happy spell on time.
  useEffect(() => {
    const ms = cheerUntil - Date.now();
    if (ms <= 0) return;
    const id = window.setTimeout(() => setNow(Date.now()), ms + 50);
    return () => clearTimeout(id);
  }, [cheerUntil]);

  // Lyrics: one lookup per track, only when opted in. Cached for the session.
  const track = snap.media ? `${snap.media.artist}\u0000${snap.media.title}` : "";
  useEffect(() => {
    const m = snap.media;
    setLyrics([]);
    if (!lyricsOn || !m?.title) return;
    const hit = lyricsCache.current.get(track);
    if (hit) return setLyrics(hit);
    let live = true;
    invoke<string>("lyrics", { artist: m.artist, title: m.title, secs: Math.round(m.duration_ms / 1000) })
      .then((lrc) => parseLrc(lrc))
      .catch(() => [] as Line[])
      .then((lines) => {
        lyricsCache.current.set(track, lines);
        if (live) setLyrics(lines);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch per track, not per position tick
  }, [track, lyricsOn]);

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
        cheer();
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
    invoke("drag_out", { paths: [d.path] }).then(() => invoke("refresh_transparency"));
  };
  // Shrinking: the region follows once the animation ends (grow is handled below).
  const onTransitionEnd = (e: React.TransitionEvent) => {
    if (!open && e.target === e.currentTarget && e.propertyName === "width") invoke("resize", wide ? COLLAPSED_LYRICS : COLLAPSED);
  };

  const { media, battery } = snap;
  const remaining = timerEnd ? fmt(timerEnd - now) : null;
  const date = new Date(now);
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const clock = hm(now);
  const playing = optimistic ?? !!media?.playing;
  // Synced lyrics: the collapsed pill widens and shows the current line while a song plays.
  const li = useLyricIndex(lyrics, media?.position_ms ?? 0, media?.position_at ?? 0, playing);
  const lyricText = playing && lyrics.length ? (li >= 0 && lyrics[li].text) || "♪" : null;
  const wide = !!lyricText;
  const working = agents.sessions.filter((a) => a.working && now - a.last < STALE_MS);
  const topAgent = agents.sessions[0];
  // Pet mood, most important first. `now` ticks each minute, so also re-check when a
  // cheer ends (below).
  const mood: Mood = Date.now() < cheerUntil ? "happy" : working.length ? "work" : away ? "sleep" : "idle";

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

  // Growing into the lyrics width: widen the clickable region first so nothing is clipped.
  useEffect(() => {
    if (wide && !open) invoke("resize", COLLAPSED_LYRICS);
  }, [wide, open]);

  // Both layers are always rendered at their own fixed size and crossfade, so nothing
  // reflows while the pill changes shape.
  // One hover area for the pill and the shortcut columns beside it, so moving onto a
  // shortcut doesn't close the island. The window region keeps the rest click-through.
  const side = (items: [string, string, string][]) => (
    <div className="side" aria-hidden={!open}>
      {items.map(([target, label, icon]) => (
        <button key={target} className="shortcut" aria-label={label} title={label} tabIndex={open ? 0 : -1} onClick={() => invoke("launch", { target })}>
          <Icon d={icon} size={18} />
        </button>
      ))}
    </div>
  );
  return (
    <div
      className={`island${open ? " open" : ""}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onContextMenu={(e) => e.preventDefault()}
      // Clicking inside the webview drops the window's transparency (white corners); restore it.
      onPointerUp={() => invoke("refresh_transparency")}
    >
      {side([
        ["settings", "Pulo settings", ICONS.gear],
        ["mixer", "Volume mixer", ICONS.mixer],
        ["task_manager", "Task Manager", ICONS.activity],
      ])}
    <div className={`pill${open ? " open" : ""}${wide ? " wide" : ""}`} onTransitionEnd={onTransitionEnd}>
      <div className="layer mini-layer" aria-hidden={open}>
        {hud ? (
          <div className="hud">
            {hud.kind === "device" ? (
              <>
                <Icon d={hud.icon ?? ICONS.bluetooth} />
                <span className={`hud-text wide${hud.flag ? " low" : ""}`}>{hud.text}</span>
              </>
            ) : hud.kind === "notification" ? (
              <>
                <Icon d={ICONS.bell} />
                <span className="hud-text wide">{hud.text}</span>
              </>
            ) : hud.kind === "agent" ? (
              <>
                <Icon d={ICONS.agent} />
                <span className="hud-text wide">{hud.text}</span>
              </>
            ) : hud.kind === "download" ? (
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
            <span className="slot">
              {playing && art ? <img className="mini-art" src={art} alt="" /> : <Pet mood={mood} key={mood} />}
            </span>
            {(() => {
              const status = remaining ?? soon;
              const lyric = !status && !songFlash && lyricText;
              return (
                <span
                  className={`center${lyric ? " lyric-mini" : " mono"}${status ? " accent" : ""}${!status && songFlash ? " flash" : ""}`}
                  key={status ? "status" : (songFlash ?? (lyric ? `l${li}` : "clock"))}
                >
                  {status ?? songFlash ?? lyricText ?? clock}
                </span>
              );
            })()}
            <span className="slot">
              {working.length ? (
                <span className="dot working" aria-label="Agent working" />
              ) : playing ? (
                <Icon d={ICONS.play} size={14} />
              ) : (
                <span className="dot" />
              )}
            </span>
          </div>
        )}
      </div>

      <div className="layer panel" aria-hidden={!open}>
        {media ? (
          <div className="media">
            {art ? <img className="art" src={art} alt="" /> : <div className="art empty" />}
            <div className="meta">
              <div className="title">{media.title || "Unknown title"}</div>
              <div className="sub-row">
                <div className="sub">{media.artist}</div>
                {open && playing && <Equalizer />}
              </div>
              {open && lyrics.length > 0 && <LyricLines lines={lyrics} i={li} />}
            </div>
            <div className="controls">
              <button aria-label="Previous" onClick={() => invoke("media", { action: "prev" })}>
                <Icon d={ICONS.prev} size={20} />
              </button>
              <button
                aria-label={playing ? "Pause" : "Play"}
                onClick={() => {
                  // Flip now; the player confirms within a second (see media_control).
                  setOptimistic(!playing);
                  clearTimeout(optimisticTimer.current);
                  optimisticTimer.current = window.setTimeout(() => setOptimistic(null), 1500);
                  invoke("media", { action: "toggle" });
                }}
              >
                <Icon d={playing ? ICONS.pause : ICONS.play} size={26} />
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
        <div className="agents">
          {topAgent ? (
            <>
              <span className={`dot${working.includes(topAgent) ? " working" : " idle"}`} />
              <span className="agent-name">{topAgent.agent}</span>
              <span className="agent-title">{topAgent.title || topAgent.project}</span>
              {working.length > 1 && <span className="more">+{working.length - 1} working</span>}
            </>
          ) : (
            <span className="agent-title">No agent sessions today</span>
          )}
          <span className="tokens mono">{fmtTokens(agents.tokens_today)} tokens today</span>
        </div>
        <div className="bar">
          <div className="bar-left">
            {battery && (
              <span className={`batt${battery.charging ? " charging" : ""}`}>
                <Icon d={battery.charging ? ICONS.power : ICONS.battery} size={14} />
                {battery.percent}%
              </span>
            )}
            {devices.map((d) => (
              <span key={d.name} className={`dev${d.percent <= 15 ? " low" : ""}`} title={`${d.name}: ${d.percent}%`} aria-label={`${d.name} battery ${d.percent}%`}>
                <Icon d={DEVICE_ICON[d.kind] ?? ICONS.bluetooth} size={14} />
                {d.percent}%
              </span>
            ))}
          </div>
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
      {side([
        ["calculator", "Calculator", ICONS.calculator],
        ["screenshot", "Screenshot", ICONS.screenshot],
        ["explorer", "File Explorer", ICONS.folder],
        ["clipboard", "Clipboard history", ICONS.clipboard],
      ])}
    </div>
  );
}
