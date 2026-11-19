import { useEffect, useMemo, useRef, useState } from "react";
import { occurrences, parseIcs, type Raw } from "./ics";
import { parseLrc, type Line } from "./lyrics";
import { Equalizer, LyricsPanel, Pet, Progress, useLyricIndex, type Mood } from "./extras";
import * as P from "./pomodoro";
import { EMPTY_SETTINGS, prefsOf, SHORTCUTS, type Settings } from "./prefs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./island.css";

type Device = { name: string; percent: number; kind: string };
type Media = {
  title: string;
  artist: string;
  playing: boolean;
  art_rev: number;
  album: string;
  duration_ms: number;
  position_ms: number;
  position_at: number;
  can_seek: boolean;
  shuffle: boolean | null; // null: the player doesn't offer it
  repeat: "none" | "track" | "list" | null;
};
type Snapshot = { media: Media | null; battery: { percent: number; charging: boolean } | null };
type Session = { agent: string; title: string; project: string; working: boolean; since: number; last: number; model: string };
type Agents = { sessions: Session[]; tokens_today: number };
type Tools = { dark: boolean; mic_muted: boolean; awake: boolean };
type Stats = { cpu: number; mem: number; down: number; up: number };
/** One line in the Recent tab. `path`: a finished download, opened on click. */
type Recent = { kind: "notification" | "download" | "agent" | "timer" | "focus"; text: string; at: number; path?: string };
type Hud = {
  kind: "volume" | "brightness" | "power" | "timer" | "focus" | "download" | "agent" | "notification" | "device" | "mic";
  level: number;
  flag: boolean;
  text?: string;
  icon?: string;
};

/** rest: the small pill. peek: hovering, a wider pill with the live thing and its controls.
 *  open: clicked, the full panel. */
type Mode = "rest" | "peek" | "open";
type Tab = "now" | "recent" | "focus" | "agents" | "tools";

// Must match .pill, .pill.peek and .pill.open in island.css (MAX in lib.rs is the open
// pill plus the shortcut columns).
const COLLAPSED = { w: 200, h: 36 };
const PEEK = { w: 360, h: 36 };
const EXPANDED = { w: 420, h: 268 };
const sizeOf = (m: Mode) => (m === "open" ? EXPANDED : m === "peek" ? PEEK : COLLAPSED);
/** Hover this long before peeking, so passing over the top edge on the way to a tab doesn't. */
const PEEK_DELAY = 120;
const PRESETS = [1, 5, 15, 25];
const TAB_LABEL: Record<Tab, string> = { now: "Now", recent: "Recent", focus: "Focus", agents: "Agents", tools: "Tools" };
const RECENT_MAX = 20;
const NO_LINES: Line[] = [];

const ICONS = {
  prev: "M6 6h2v12H6zm3.5 6 8.5 6V6z",
  next: "M16 6h2v12h-2zm-10 12 8.5-6L6 6z",
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zm8 0h4v14h-4z",
  music: "M12 3v10.6A4 4 0 1 0 14 17V7h4V3z",
  back: "M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z",
  shuffle: "M10.6 9.2 5.4 4 4 5.4l5.2 5.2zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4zm.3 9.4-1.4 1.4 3.1 3.1-2 2H20v-5.5l-2 2z",
  repeat: "M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z",
  repeatOne: "M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2zm-4-2V9h-1l-2 1v1h1.5v4z",
  lyrics: "M4 5h16v2H4zm0 4h16v2H4zm0 4h10v2H4zm0 4h7v2H4zm14-4v4.3a2 2 0 1 0 2 1.7V15h2v-2z",
  reset: "M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z",
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
  note: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z",
  moon: "M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.4 5.4 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z",
  mic: "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5.3-3a5.3 5.3 0 0 1-10.6 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z",
  micOff:
    "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23A6.9 6.9 0 0 0 19 11zm-4.02.17c0-.06.02-.11.02-.17V5a3 3 0 0 0-6 0v.18zM4.27 3 3 4.27l6.01 6.01V11a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52A5.3 5.3 0 0 1 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28a6.9 6.9 0 0 0 2.54-.9L19.73 21 21 19.73z",
  coffee: "M2 21h18v-2H2zM20 8h-2V5h2zm0-5H4v10a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4v-3h2a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z",
  lock: "M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9zm3 11a2 2 0 1 1 0-4 2 2 0 0 1 0 4z",
  trash: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z",
};
const DEVICE_ICON: Record<string, string> = { mouse: ICONS.mouse, keyboard: ICONS.keyboard, headphones: ICONS.headphones };
const SHORTCUT_ICON: Record<string, string> = {
  settings: ICONS.gear,
  mixer: ICONS.mixer,
  task_manager: ICONS.activity,
  calculator: ICONS.calculator,
  screenshot: ICONS.screenshot,
  explorer: ICONS.folder,
  clipboard: ICONS.clipboard,
  scratchpad: ICONS.note,
};
const HUD_ICON: Partial<Record<Hud["kind"], string>> = {
  notification: ICONS.bell,
  agent: ICONS.agent,
  download: ICONS.download,
  timer: ICONS.timer,
  focus: ICONS.timer,
  device: ICONS.bluetooth,
};

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
const fmtDur = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const fmtAgo = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
};
const fmtRate = (b: number) =>
  b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB/s` : b >= 1e3 ? `${Math.round(b / 1e3)} KB/s` : `${Math.round(b)} B/s`;
/** "claude-opus-5-5" -> "Opus 5.5". Dated ids ("claude-opus-4-20250514") drop the date. */
const shortModel = (id: string) => {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
};

const fileName = (p: string) => p.split(/[\\/]/).pop() || p;

/** localStorage, which can throw or come back empty; the island works without it. */
function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/** Browsers report their own logo as the album art until the page sets a cover (seen with
 *  Chrome). Logos are round with see-through corners; covers are solid rectangles. */
async function inspectArt(blob: Blob): Promise<{ icon: boolean; tint: string | null }> {
  try {
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(16, 16);
    const g = c.getContext("2d")!;
    g.drawImage(bmp, 0, 0, 16, 16);
    bmp.close();
    const px = g.getImageData(0, 0, 16, 16).data;
    const a = (x: number, y: number) => px[(y * 16 + x) * 4 + 3];
    const icon = [a(0, 0), a(15, 0), a(0, 15), a(15, 15)].some((v) => v < 250);
    return { icon, tint: icon ? null : tintOf(px) };
  } catch {
    return { icon: false, tint: null }; // undecodable: let the <img> deal with it
  }
}

/** The cover's dominant colour as a deep background shade (like Apple Music's lyrics), dark
 *  enough that white text keeps its contrast whatever the cover. Pixels count by how colourful
 *  they are, so a red shirt on a grey photo gives red, not grey; only a truly grey cover stays
 *  grey. */
function tintOf(px: Uint8ClampedArray) {
  let r = 0, g = 0, b = 0, w = 0, sat = 0;
  for (let i = 0; i < px.length; i += 4) {
    const c = Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]);
    const k = c * c + 1; // colourful pixels dominate; +1 keeps grey covers defined
    r += px[i] * k;
    g += px[i + 1] * k;
    b += px[i + 2] * k;
    w += k;
    sat += c;
  }
  [r, g, b] = [r / w / 255, g / w / 255, b / w / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const grey = sat / (px.length / 4) < 12; // average chroma out of 255
  const S = grey ? Math.min(s, 0.1) : Math.min(Math.max(s, 0.45), 0.7);
  return `hsl(${Math.round(h * 60 + 360) % 360} ${Math.round(S * 100)}% 22%)`;
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

/** Run `f` without the click also reaching the pill (which would open the panel). */
const only = (f: () => void) => (e: React.MouseEvent) => {
  e.stopPropagation();
  f();
};

export default function App() {
  const [mode, setMode] = useState<Mode>("rest");
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const prefs = useMemo(() => prefsOf(settings), [settings]);
  const has = (f: string) => !settings.off.includes(f);
  // Event listeners are registered once; they read the latest settings through refs.
  const live = useRef(has);
  live.current = has;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const [snap, setSnap] = useState<Snapshot>({ media: null, battery: null });
  const [art, setArt] = useState<string | null>(null);
  const [tint, setTint] = useState<string | null>(null); // cover colour, behind the music page
  const [hud, setHud] = useState<Hud | null>(null);
  const [timerEnd, setTimerEnd] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const leave = useRef<number | undefined>(undefined);
  const hoverTimer = useRef<number | undefined>(undefined);
  const hudTimer = useRef<number | undefined>(undefined);
  const audio = useRef<AudioContext | null>(null);
  const [events, setEvents] = useState<Raw[]>([]);
  const [agents, setAgents] = useState<Agents>({ sessions: [], tokens_today: 0 });
  const [devices, setDevices] = useState<Device[]>([]);
  const [tools, setTools] = useState<Tools>({ dark: false, mic_muted: false, awake: false });
  const micRef = useRef(false);
  // Play/pause shown right after a click, until the player reports back.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const optimisticTimer = useRef<number | undefined>(undefined);
  const [lyrics, setLyrics] = useState<Line[]>([]);
  // Music page (the music button in Now): full player with seek, shuffle, repeat, volume, lyrics.
  const [musicPage, setMusicPage] = useState(false);
  const [showLyrics, setShowLyrics] = useState(() => load("showLyrics", true));
  const [volume, setVolume] = useState(0);
  const lyricsCache = useRef(new Map<string, Line[]>());
  const [away, setAway] = useState(false);
  const [faded, setFaded] = useState(false); // click-through mode, mouse over the pill
  const [cheerUntil, setCheerUntil] = useState(0);
  const cheer = () => setCheerUntil(Date.now() + 12_000);
  const [tab, setTab] = useState<Tab>(() => load("tab", "now"));
  const [pomo, setPomo] = useState<P.Pomo>(() => load("pomodoro", null) ?? P.initial(P.DEFAULTS, Date.now()));
  const [recent, setRecent] = useState<Recent[]>(() => load("recent", []));
  const [stats, setStats] = useState<Stats | null>(null);

  // Newest first, kept across restarts.
  const addRecent = (kind: Recent["kind"], text: string, path?: string) =>
    setRecent((cur) => {
      const next = [{ kind, text, at: Date.now(), path }, ...cur].slice(0, RECENT_MAX);
      save("recent", next);
      return next;
    });
  const clearRecent = () => {
    setRecent([]);
    save("recent", []);
  };

  const showHud = (h: Hud, ms = 1600) => {
    setHud(h);
    clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setHud(null), ms);
  };

  // ---------- window region and the three states ----------

  // What the window region currently allows; it must cover the pill before the pill grows
  // into it, and shrinks only once the pill has finished shrinking.
  const region = useRef({ ...COLLAPSED, open: false });
  const intent = useRef<Mode>("rest");
  const setRegion = (s: { w: number; h: number }, open: boolean) => {
    region.current = { ...s, open };
    const p = prefsRef.current;
    return invoke("resize", { w: s.w, h: s.h, left: open ? p.left.length : 0, right: open ? p.right.length : 0 });
  };
  function go(next: Mode) {
    intent.current = next;
    clearTimeout(hoverTimer.current);
    const t = sizeOf(next);
    const r = region.current;
    if (t.w > r.w || t.h > r.h || (next === "open" && !r.open)) {
      // Only if nothing else was asked for while the region grew (the mouse may have left).
      setRegion(t, next === "open").then(() => intent.current === next && setMode(next));
    } else setMode(next);
  }
  function collapseSoon(ms: number) {
    clearTimeout(leave.current);
    leave.current = window.setTimeout(() => go("rest"), ms);
  }
  const onEnter = () => {
    clearTimeout(leave.current);
    if (intent.current !== "rest") return;
    if (prefs.openOn === "hover") return go("open");
    clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => go("peek"), PEEK_DELAY);
  };
  const onLeave = () => {
    clearTimeout(hoverTimer.current);
    collapseSoon(intent.current === "open" ? 400 : 150);
  };
  // Shrinking: the region follows once the pill's size transition ends.
  const onTransitionEnd = (e: React.TransitionEvent) => {
    if (e.target !== e.currentTarget || (e.propertyName !== "width" && e.propertyName !== "height")) return;
    const t = sizeOf(mode);
    const r = region.current;
    if (t.w !== r.w || t.h !== r.h || r.open !== (mode === "open")) setRegion(t, mode === "open");
  };

  // ---------- data from Rust ----------

  useEffect(() => {
    invoke<Snapshot>("snapshot").then(setSnap);
    invoke<string>("calendar").then((t) => setEvents(parseIcs(t)));
    invoke<Agents>("agents").then(setAgents);
    invoke<Device[]>("devices").then(setDevices);
    invoke<Settings>("get_settings").then(setSettings);
    invoke<Tools>("tools_state").then((t) => {
      micRef.current = t.mic_muted;
      setTools(t);
    });
    const on = (f: string) => live.current(f);
    const un = [
      listen<Snapshot>("state", (e) => setSnap(e.payload)),
      listen<Settings>("settings", (e) => setSettings(e.payload)),
      listen<[Hud["kind"], number, boolean]>("hud", (e) => {
        const [kind, level, flag] = e.payload;
        showHud({ kind, level, flag });
      }),
      listen<string>("calendar", (e) => setEvents(parseIcs(e.payload))),
      listen<Agents>("agents", (e) => setAgents(e.payload)),
      listen<[string, string]>("agent_done", (e) => {
        if (!on("agents")) return;
        cheer();
        const text = `Claude finished · ${e.payload[0]}`;
        addRecent("agent", text);
        showHud({ kind: "agent", level: 1, flag: false, text }, 8000);
      }),
      // Keyboard shortcut (Ctrl+Alt+Space): open, or close if open.
      listen("hotkey", () => {
        if (!on("hotkey")) return;
        if (intent.current === "open") return go("rest");
        go("open");
        // The mouse may be nowhere near it: close again unless it comes over (onEnter cancels this).
        collapseSoon(4000);
      }),
      listen<boolean>("away", (e) => setAway(e.payload)),
      // Click-through mode (watch_click_through in lib.rs): fade while the mouse is over the
      // pill, and treat clicks starting to pass through as the mouse leaving.
      listen<boolean>("dim", (e) => setFaded(e.payload)),
      listen<boolean>("passthrough", (e) => e.payload && onLeave()),
      listen<Device[]>("devices", (e) => setDevices(e.payload)),
      listen<Device>("device_connected", (e) => {
        if (on("devices"))
          showHud({ kind: "device", level: e.payload.percent / 100, flag: false, text: `${e.payload.percent}%`, icon: DEVICE_ICON[e.payload.kind] }, 4000);
      }),
      listen<Device>("device_low", (e) => {
        if (on("devices"))
          showHud({ kind: "device", level: e.payload.percent / 100, flag: true, text: `Low · ${e.payload.percent}%`, icon: DEVICE_ICON[e.payload.kind] }, 6000);
      }),
      listen<[string, string, string]>("notification", (e) => {
        const [app, title, body] = e.payload;
        if (!on("notifications")) return;
        const text = [app, title].filter(Boolean).join(" · ");
        addRecent("notification", body ? `${text} · ${body}` : text);
        showHud({ kind: "notification", level: 1, flag: false, text }, 5000);
      }),
      listen<string>("download", (e) => {
        if (!on("downloads")) return;
        cheer();
        addRecent("download", fileName(e.payload), e.payload);
        showHud({ kind: "download", level: 1, flag: false, text: fileName(e.payload) }, 4000);
      }),
      // Fires on mic level changes too; only a change of mute counts.
      listen<boolean>("mic", (e) => {
        if (e.payload === micRef.current) return;
        micRef.current = e.payload;
        setTools((t) => ({ ...t, mic_muted: e.payload }));
        if (on("tools"))
          showHud({ kind: "mic", level: 1, flag: e.payload, text: e.payload ? "Microphone muted" : "Microphone on", icon: e.payload ? ICONS.micOff : ICONS.mic }, 2500);
      }),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registered once; reads state through refs
  }, []);

  // Album art: refetch raw bytes whenever Rust bumps art_rev.
  const artRev = snap.media?.art_rev;
  useEffect(() => {
    if (!artRev) {
      setTint(null);
      return setArt(null);
    }
    let url: string | null = null;
    let alive = true;
    invoke<ArrayBuffer>("media_art").then(async (buf) => {
      const blob = new Blob([buf]);
      // An app's logo isn't album art: show nothing (the pet) until the real cover arrives.
      const seen = buf.byteLength > 0 ? await inspectArt(blob) : { icon: true, tint: null };
      if (!alive) return;
      url = seen.icon ? null : URL.createObjectURL(blob);
      setArt(url);
      setTint(seen.tint);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [artRev]);

  const media = has("media") ? snap.media : null;
  const { battery } = snap;

  // When a track starts (or playback resumes), show its title in the pill for a few seconds.
  const [songFlash, setSongFlash] = useState<string | null>(null);
  const songTitle = media?.playing ? media.title : "";
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
  const lyricsOn = settings.lyrics && has("media");
  const track = media ? `${media.artist}\u0000${media.title}` : "";
  useEffect(() => {
    setLyrics([]);
    if (!lyricsOn || !media?.title) return;
    const hit = lyricsCache.current.get(track);
    if (hit) return setLyrics(hit);
    let alive = true;
    invoke<string>("lyrics", { artist: media.artist, title: media.title, secs: Math.round(media.duration_ms / 1000) })
      .then((lrc) => parseLrc(lrc))
      .catch(() => [] as Line[])
      .then((lines) => {
        lyricsCache.current.set(track, lines);
        if (alive) setLyrics(lines);
      });
    return () => {
      alive = false;
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

  // Quick timer: ticks only while one is running.
  useEffect(() => {
    if (!timerEnd) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= timerEnd) {
        setTimerEnd(null);
        if (audio.current) chime(audio.current);
        cheer();
        addRecent("timer", "Timer done");
        showHud({ kind: "timer", level: 1, flag: false, text: "Timer done" }, 6000);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [timerEnd]);

  const startTimer = (min: number) => {
    audio.current ??= new AudioContext(); // created on a click so the chime may play later
    setNow(Date.now());
    setTimerEnd(Date.now() + min * 60_000);
  };

  // ---------- focus (pomodoro) ----------

  const cfg = prefs.pomodoro;
  useEffect(() => save("pomodoro", pomo), [pomo]);
  // A phase that hasn't started follows changed lengths from Settings.
  const lastCfg = useRef(cfg);
  useEffect(() => {
    const old = lastCfg.current;
    lastCfg.current = cfg;
    if (old !== cfg) setPomo((p) => P.resize(p, old, cfg));
  }, [cfg]);
  useEffect(() => {
    if (pomo.end === null) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      const r = P.tick(pomo, cfg, t);
      if (!r.finished) return;
      // Ended a while ago (the PC slept, or Pulo was closed): move on quietly, and don't
      // auto-start a phase nobody is there for.
      if (t - pomo.end! > 60_000) return setPomo(P.advance(pomo, { ...cfg, auto: false }, t, true));
      setPomo(r.next);
      if (audio.current) chime(audio.current);
      if (r.finished === "focus") cheer();
      const text = r.finished === "focus" ? "Focus done · take a break" : "Break over · back to focus";
      addRecent("focus", text);
      showHud({ kind: "focus", level: 1, flag: false, text }, 6000);
    }, 1000);
    return () => clearInterval(id);
  }, [pomo, cfg]);
  const pomoStart = () => {
    audio.current ??= new AudioContext();
    setNow(Date.now());
    setPomo((p) => P.start(p, Date.now()));
  };
  const pomoPause = () => setPomo((p) => P.pause(p, Date.now()));
  const pomoSkip = () => setPomo((p) => P.advance(p, cfg, Date.now(), false));
  const pomoReset = () => setPomo((p) => P.reset(p, cfg, Date.now()));
  const focusOn = has("focus");
  const pomoRunning = focusOn && pomo.end !== null;
  const pomoLeft = P.remaining(pomo, now);
  const pomoTotal = P.length(pomo.phase, cfg);
  const pomoActive = focusOn && (pomoRunning || pomo.left < pomoTotal);
  const phaseCls = pomo.phase === "focus" ? "accent" : "break";
  const doneToday = pomo.day === new Date(now).toDateString() ? pomo.done : 0;

  // ---------- derived ----------

  const remaining = timerEnd ? fmt(timerEnd - now) : null;
  const date = new Date(now);
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const clock = hm(now);
  const playing = optimistic ?? !!media?.playing;
  const isOpen = mode === "open";
  // Synced lyrics show on the music page only; follow the song only while they're on screen.
  const lyricsShown = isOpen && musicPage && showLyrics && lyrics.length > 0;
  const li = useLyricIndex(lyricsShown ? lyrics : NO_LINES, media?.position_ms ?? 0, media?.position_at ?? 0, playing);
  const agentsOn = has("agents");
  const working = agentsOn ? agents.sessions.filter((a) => a.working && now - a.last < STALE_MS) : [];
  const toolsOn = has("tools");
  const micMuted = toolsOn && tools.mic_muted;
  // Pet mood, most important first. `now` ticks each minute, so also re-check when a
  // cheer ends (above).
  const mood: Mood =
    Date.now() < cheerUntil ? "happy" : working.length || (pomoRunning && pomo.phase === "focus") ? "work" : away ? "sleep" : "idle";

  // Next timed event that hasn't ended, looking up to 36 hours ahead. Recomputed each minute.
  const calEvents = has("calendar") ? events : [];
  const next = useMemo(
    () => occurrences(calEvents, now, now + 36 * 3_600_000).find((o) => !o.allDay && o.end > now) ?? null,
    [calEvents, now],
  );
  const minsUntil = next ? Math.ceil((next.start - now) / 60_000) : Infinity;
  // Collapsed pill shows the event from 15 minutes before until 5 minutes after it starts.
  const soon = next && minsUntil <= 15 && minsUntil > -5 ? `${next.title} · ${minsUntil > 0 ? `${minsUntil}m` : "now"}` : null;
  const when = (t: number) =>
    t <= now ? "Now" : (new Date(t).getDate() === date.getDate() ? "" : "Tomorrow ") + hm(t);
  const nextLabel = next ? `${when(next.start)} · ${next.title}` : null;

  // Speaker volume for the music page slider: read when the page opens.
  useEffect(() => {
    if (isOpen && musicPage) invoke<number>("volume").then(setVolume);
  }, [isOpen, musicPage]);
  // Shortcuts changed in Settings while open: the region needs the new button count.
  useEffect(() => {
    if (mode === "open") setRegion(EXPANDED, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the counts change
  }, [prefs.left.length, prefs.right.length]);

  const tabs: Tab[] = [
    "now",
    "recent",
    ...(focusOn ? ["focus" as const] : []),
    ...(agentsOn ? ["agents" as const] : []),
    ...(toolsOn ? ["tools" as const] : []),
  ];
  const shown: Tab = tabs.includes(tab) ? tab : "now";
  // System stats: sampled only while someone is looking at them.
  const statsVisible = mode === "open" && shown === "tools";
  useEffect(() => {
    if (!statsVisible) return;
    const get = () => invoke<Stats>("stats").then(setStats);
    get();
    const id = window.setInterval(get, 2000);
    return () => clearInterval(id);
  }, [statsVisible]);
  const pickTab = (t: Tab) => {
    setTab(t);
    save("tab", t);
  };

  const togglePlay = () => {
    // Flip now; the player confirms within a second (see media_control).
    setOptimistic(!playing);
    clearTimeout(optimisticTimer.current);
    optimisticTimer.current = window.setTimeout(() => setOptimistic(null), 1500);
    invoke("media", { action: "toggle" });
  };
  const runTool = (action: string) =>
    invoke<Tools>("tool", { action }).then((t) => {
      micRef.current = t.mic_muted;
      setTools(t);
    });

  // ---------- pieces ----------

  const hudEl = hud && (
    <div className="hud">
      {hud.kind === "power" ? (
        <>
          <Icon d={hud.flag ? ICONS.power : ICONS.battery} />
          <span>
            {hud.flag ? "Charging" : "On battery"} · {Math.round(hud.level * 100)}%
          </span>
        </>
      ) : hud.kind === "volume" || hud.kind === "brightness" ? (
        <>
          <Icon d={hud.kind === "brightness" ? ICONS.brightness : hud.flag ? ICONS.mute : ICONS.volume} />
          <div className="meter">
            <div style={{ width: `${hud.flag ? 0 : hud.level * 100}%` }} />
          </div>
          <span className="mono pct">{hud.flag ? "Muted" : Math.round(hud.level * 100)}</span>
        </>
      ) : (
        <>
          <Icon d={hud.icon ?? HUD_ICON[hud.kind] ?? ICONS.bell} />
          <span className={`hud-text${hud.flag ? " low" : ""}`}>{hud.text}</span>
        </>
      )}
    </div>
  );

  const status = remaining ?? (pomoRunning ? fmt(pomoLeft) : null) ?? soon;
  const statusCls = remaining || soon ? "accent" : phaseCls;

  // One hover area for the pill and the shortcut columns beside it, so moving onto a
  // shortcut doesn't close the island. The window region keeps the rest click-through.
  const side = (items: string[]) => (
    <div className="side" aria-hidden={!isOpen}>
      {items.map((target) => (
        <button
          key={target}
          className="shortcut"
          aria-label={SHORTCUTS[target]}
          title={SHORTCUTS[target]}
          tabIndex={isOpen ? 0 : -1}
          onClick={() => invoke("launch", { target })}
        >
          <Icon d={SHORTCUT_ICON[target]} size={18} />
        </button>
      ))}
    </div>
  );

  const quickTimer = (
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
  );

  const transport = (
    <div className="controls">
      <button aria-label="Previous" onClick={() => invoke("media", { action: "prev" })}>
        <Icon d={ICONS.prev} size={20} />
      </button>
      <button className="play" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay}>
        <Icon d={playing ? ICONS.pause : ICONS.play} size={22} />
      </button>
      <button aria-label="Next" onClick={() => invoke("media", { action: "next" })}>
        <Icon d={ICONS.next} size={20} />
      </button>
    </div>
  );
  const toggleLyrics = () => {
    setShowLyrics(!showLyrics);
    save("showLyrics", !showLyrics);
  };
  const progressEl = media && (
    <Progress
      duration={media.duration_ms}
      position={media.position_ms}
      at={media.position_at}
      playing={playing}
      canSeek={media.can_seek}
      onSeek={(ms) => invoke("media", { action: "seek", value: Math.round(ms) })}
    />
  );
  const lyricsBtn = lyricsOn && (
    <button className={`icon-btn${showLyrics ? " on" : ""}`} aria-label="Lyrics" aria-pressed={showLyrics} onClick={toggleLyrics}>
      <Icon d={ICONS.lyrics} size={16} />
    </button>
  );
  // Lyrics on: they take the panel, with the player shrunk to one row above them.
  const lyricsMode = lyricsOn && showLyrics;
  const musicEl = media && (
    <div className={`music${lyricsMode ? " lyrics-mode" : ""}`}>
      <div className="media">
        <button className="icon-btn" aria-label="Back" onClick={() => setMusicPage(false)}>
          <Icon d={ICONS.back} size={16} />
        </button>
        {art ? <img className="art small" src={art} alt="" /> : <div className="art small empty"><Icon d={ICONS.music} size={18} /></div>}
        <div className="meta">
          <div className="title">{media.title || "Unknown title"}</div>
          <div className="sub">{[media.artist, media.album].filter(Boolean).join(" · ")}</div>
        </div>
        {transport}
        {lyricsMode && lyricsBtn}
      </div>
      {progressEl}
      {lyricsMode ? (
        lyrics.length ? (
          <LyricsPanel lines={lyrics} i={li} onSeek={media.can_seek ? (ms) => invoke("media", { action: "seek", value: ms }) : undefined} />
        ) : (
          <div className="lyrics-none">No synced lyrics for this song</div>
        )
      ) : (
      <div className="music-row">
        {media.shuffle !== null && (
          <button className={`icon-btn${media.shuffle ? " on" : ""}`} aria-label="Shuffle" aria-pressed={media.shuffle} onClick={() => invoke("media", { action: "shuffle" })}>
            <Icon d={ICONS.shuffle} size={16} />
          </button>
        )}
        {media.repeat !== null && (
          <button
            className={`icon-btn${media.repeat !== "none" ? " on" : ""}`}
            aria-label={`Repeat: ${media.repeat === "track" ? "this song" : media.repeat === "list" ? "all" : "off"}`}
            onClick={() => invoke("media", { action: "repeat" })}
          >
            <Icon d={media.repeat === "track" ? ICONS.repeatOne : ICONS.repeat} size={16} />
          </button>
        )}
        <Icon d={volume > 0 ? ICONS.volume : ICONS.mute} size={16} />
        <input
          type="range"
          className="slider volume"
          min={0}
          max={1}
          step={0.02}
          value={volume}
          aria-label="Volume"
          style={{ "--pct": `${volume * 100}%` } as React.CSSProperties}
          onChange={(e) => {
            setVolume(+e.target.value);
            invoke("set_volume", { level: +e.target.value });
          }}
        />
        {lyricsBtn}
      </div>
      )}
    </div>
  );
  // The music page has the whole panel: no tabs (Back returns), the cover's colour behind it.
  const musicOpen = isOpen && shown === "now" && musicPage && !!media;

  const nowTab = musicPage && musicEl ? musicEl : (
    <>
      {media ? (
        <div className="player">
          <div className="media">
            {art ? <img className="art" src={art} alt="" /> : <div className="art empty"><Icon d={ICONS.music} size={28} /></div>}
            <div className="meta">
              <div className="title">{media.title || "Unknown title"}</div>
              <div className="sub-row">
                <div className="sub">{media.artist}</div>
                {isOpen && playing && has("equalizer") && <Equalizer />}
              </div>
            </div>
            {transport}
          </div>
          <div className="player-row">
            {progressEl}
            <button className="icon-btn music-open" aria-label="Music: lyrics, volume, shuffle" title="Lyrics, volume, shuffle" onClick={() => setMusicPage(true)}>
              <Icon d={ICONS.lyrics} size={16} />
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
      <div className="bar">
        <div className="bar-left">
          {battery && (
            <span className={`batt${battery.charging ? " charging" : ""}`}>
              <Icon d={battery.charging ? ICONS.power : ICONS.battery} size={14} />
              {battery.percent}%
            </span>
          )}
          {has("devices") &&
            devices.map((d) => (
              <span key={d.name} className={`dev${d.percent <= 15 ? " low" : ""}`} title={`${d.name}: ${d.percent}%`} aria-label={`${d.name} battery ${d.percent}%`}>
                <Icon d={DEVICE_ICON[d.kind] ?? ICONS.bluetooth} size={14} />
                {d.percent}%
              </span>
            ))}
        </div>
        {remaining && quickTimer}
      </div>
    </>
  );

  const RING = 2 * Math.PI * 40;
  const roundNow = Math.min(pomo.phase === "focus" ? pomo.round + 1 : pomo.round, cfg.every);
  const focusTab = (
    <>
      <div className="focus">
        <div className="ring">
          <svg width="120" height="120" viewBox="0 0 92 92" aria-hidden="true">
            <circle cx="46" cy="46" r="40" className="track" />
            <circle
              cx="46"
              cy="46"
              r="40"
              className={`progress ${phaseCls}`}
              strokeDasharray={RING}
              strokeDashoffset={RING * (pomoLeft / pomoTotal)}
              transform="rotate(-90 46 46)"
            />
          </svg>
          <span className="ring-time mono">{fmt(pomoLeft)}</span>
        </div>
        <div className="focus-side">
          <div className={`phase-label ${phaseCls}`}>{P.LABEL[pomo.phase]}</div>
          <div className="rounds" role="img" aria-label={`Round ${roundNow} of ${cfg.every}`}>
            {Array.from({ length: cfg.every }, (_, k) => (
              <span key={k} className={k < pomo.round ? "done" : k === pomo.round && pomo.phase === "focus" ? "now" : ""} />
            ))}
            <span className="sub">{doneToday ? `${doneToday} done today` : `Round ${roundNow} of ${cfg.every}`}</span>
          </div>
          <div className="focus-controls">
            <button className={pomoRunning ? "primary" : `primary go ${phaseCls}`} onClick={pomoRunning ? pomoPause : pomoStart}>
              <Icon d={pomoRunning ? ICONS.pause : ICONS.play} size={16} />
              {pomoRunning ? "Pause" : pomoActive ? "Resume" : "Start"}
            </button>
            <button aria-label="Skip to the next phase" title="Skip" onClick={pomoSkip}>
              <Icon d={ICONS.next} size={18} />
            </button>
            <button aria-label="Reset" title="Reset" onClick={pomoReset}>
              <Icon d={ICONS.reset} size={18} />
            </button>
          </div>
        </div>
      </div>
      <div className="bar">
        <span>Quick timer</span>
        {quickTimer}
      </div>
    </>
  );

  const agentsTab = (
    <>
      <div className="agent-list">
        {agents.sessions.length ? (
          agents.sessions.map((s, i) => {
            const busy = working.includes(s);
            const meta = [s.title ? s.project : "", shortModel(s.model)].filter(Boolean).join(" · ");
            return (
              <div className="agent-row" key={i}>
                <span className={`dot${busy ? " working" : " idle"}`} aria-label={busy ? "Working" : "Idle"} />
                <span className="agent-title">{s.title || s.project}</span>
                <span className="agent-meta">{meta}</span>
                <span className="agent-time mono">{busy ? fmtDur(now - s.since) : fmtAgo(now - s.last)}</span>
              </div>
            );
          })
        ) : (
          <div className="empty-note">No Claude Code sessions in the last day</div>
        )}
      </div>
      <div className="bar">
        <span className={working.length ? "more" : ""}>{working.length ? `${working.length} working` : "All idle"}</span>
        <span className="mono">{fmtTokens(agents.tokens_today)} tokens today</span>
      </div>
    </>
  );

  const tiles: [string, string, string, boolean | undefined][] = [
    ["dark", "Dark mode", ICONS.moon, tools.dark],
    ["mic", tools.mic_muted ? "Mic muted" : "Mic on", tools.mic_muted ? ICONS.micOff : ICONS.mic, tools.mic_muted],
    ["awake", "Keep awake", ICONS.coffee, tools.awake],
    ["lock", "Lock", ICONS.lock, undefined],
    ["empty_bin", "Empty bin", ICONS.trash, undefined],
    ["scratchpad", "Scratchpad", ICONS.note, undefined],
  ];
  const toolsTab = (
    <>
      <div className="tools">
        {tiles.map(([action, label, icon, pressed]) => (
          <button
            key={action}
            className={`tile${pressed ? " on" : ""}${action === "mic" && pressed ? " warn" : ""}`}
            aria-pressed={pressed}
            onClick={() => (action === "scratchpad" ? invoke("launch", { target: "scratchpad" }) : runTool(action))}
          >
            <Icon d={icon} size={20} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="bar mono">
        <span>
          CPU {stats && stats.cpu >= 0 ? `${Math.round(stats.cpu)}%` : "–"} · Memory {stats ? `${stats.mem}%` : "–"}
        </span>
        <span>{stats && stats.cpu >= 0 ? `↓ ${fmtRate(stats.down)}  ↑ ${fmtRate(stats.up)}` : ""}</span>
      </div>
    </>
  );

  const RECENT_ICON: Record<Recent["kind"], string> = {
    notification: ICONS.bell,
    download: ICONS.download,
    agent: ICONS.agent,
    timer: ICONS.timer,
    focus: ICONS.timer,
  };
  const recentTab = (
    <>
      <div className="recent-list">
        {recent.length ? (
          recent.map((r, i) =>
            r.path ? (
              <button key={i} className="recent-row" title={r.path} onClick={() => invoke("open_path", { path: r.path })}>
                <Icon d={RECENT_ICON[r.kind]} size={14} />
                <span className="recent-text">{r.text}</span>
                <span className="agent-time">{fmtAgo(now - r.at)}</span>
              </button>
            ) : (
              <div key={i} className="recent-row">
                <Icon d={RECENT_ICON[r.kind]} size={14} />
                <span className="recent-text">{r.text}</span>
                <span className="agent-time">{fmtAgo(now - r.at)}</span>
              </div>
            ),
          )
        ) : (
          <div className="empty-note">Notifications, downloads and finished timers show up here</div>
        )}
      </div>
      <div className="bar">
        <span>{recent.length ? `${recent.length} recent` : ""}</span>
        {recent.length > 0 && (
          <button className="chip" onClick={clearRecent}>
            Clear
          </button>
        )}
      </div>
    </>
  );

  const peekEl = pomoActive ? (
    <div className="peek-row">
      <span className={`peek-tag ${phaseCls}`}>{P.LABEL[pomo.phase]}</span>
      <span className="peek-main mono">{fmt(pomoLeft)}</span>
      <button aria-label={pomoRunning ? "Pause" : "Resume"} onClick={only(pomoRunning ? pomoPause : pomoStart)}>
        <Icon d={pomoRunning ? ICONS.pause : ICONS.play} />
      </button>
      <button aria-label="Skip to the next phase" onClick={only(pomoSkip)}>
        <Icon d={ICONS.next} />
      </button>
    </div>
  ) : media ? (
    <div className="peek-row">
      {art ? <img className="mini-art" src={art} alt="" /> : <span className="mini-art empty" />}
      <span className="peek-main">
        {media.title || "Unknown title"}
        {media.artist && <span className="dim"> · {media.artist}</span>}
      </span>
      <button aria-label="Previous" onClick={only(() => invoke("media", { action: "prev" }))}>
        <Icon d={ICONS.prev} />
      </button>
      <button aria-label={playing ? "Pause" : "Play"} onClick={only(togglePlay)}>
        <Icon d={playing ? ICONS.pause : ICONS.play} size={18} />
      </button>
      <button aria-label="Next" onClick={only(() => invoke("media", { action: "next" }))}>
        <Icon d={ICONS.next} />
      </button>
    </div>
  ) : (
    <div className="peek-row">
      <span className="peek-tag mono">{clock}</span>
      <span className="peek-main dim">{nextLabel ?? date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</span>
      {micMuted && (
        <span className="mic-off" aria-label="Microphone muted">
          <Icon d={ICONS.micOff} size={14} />
        </span>
      )}
    </div>
  );

  return (
    <div
      className={`island ${mode}${faded ? " faded" : ""}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onContextMenu={(e) => e.preventDefault()}
      // Clicking inside the webview drops the window's transparency (white corners); restore it.
      onPointerUp={() => invoke("refresh_transparency")}
    >
      {side(prefs.left)}
      <div
        className={`pill ${mode}${musicOpen && tint ? " tinted" : ""}`}
        style={tint ? ({ "--tint": tint } as React.CSSProperties) : undefined}
        onTransitionEnd={onTransitionEnd}
        onClick={() => {
          if (intent.current !== "open") {
            clearTimeout(leave.current);
            go("open");
          }
        }}
      >
        <div className="layer mini-layer" aria-hidden={mode !== "rest"}>
          {hudEl || (
            <div className="mini">
              <span className="slot">
                {playing && art ? <img className="mini-art" src={art} alt="" /> : has("pet") && <Pet mood={mood} key={mood} />}
              </span>
              <span
                className={`center mono${status ? ` ${statusCls}` : ""}${!status && songFlash ? " flash" : ""}`}
                key={status ? "status" : (songFlash ?? "clock")}
              >
                {status ?? songFlash ?? clock}
              </span>
              <span className="slot">
                {micMuted ? (
                  <span className="mic-off" aria-label="Microphone muted">
                    <Icon d={ICONS.micOff} size={14} />
                  </span>
                ) : playing && mode === "rest" && has("equalizer") ? (
                  // Live waveform while the pill is at rest (unmounting it stops the capture).
                  // Orange while an agent works, so that signal isn't lost under the music.
                  <Equalizer className={`wave${working.length ? " working" : ""}`} fps={20} />
                ) : working.length ? (
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

        <div className="layer peek-layer" aria-hidden={mode !== "peek"}>
          {hudEl || peekEl}
        </div>

        <div className="layer panel" aria-hidden={!isOpen}>
          {tabs.length > 1 && !musicOpen && (
            <div className="tabs" role="tablist">
              {tabs.map((t) => (
                <button key={t} role="tab" aria-selected={t === shown} className={`tab${t === shown ? " on" : ""}`} tabIndex={isOpen ? 0 : -1} onClick={() => pickTab(t)}>
                  {TAB_LABEL[t]}
                </button>
              ))}
            </div>
          )}
          <div className="tab-body">
            {shown === "now"
              ? nowTab
              : shown === "recent"
                ? recentTab
                : shown === "focus"
                  ? focusTab
                  : shown === "agents"
                    ? agentsTab
                    : toolsTab}
          </div>
        </div>
      </div>
      {side(prefs.right)}
    </div>
  );
}
