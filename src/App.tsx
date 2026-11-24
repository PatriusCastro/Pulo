import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { occurrences, parseIcs, type Raw } from "./ics";
import { parseLrc, type Line } from "./lyrics";
import { Equalizer, LyricsPanel, Pet, Progress, useLyricIndex, type Mood } from "./extras";
import * as P from "./pomodoro";
import { ICONS, Icon } from "./icons";
import { ToolPage, clockLeft, fmtRate, isTool, type PowerTimer, type Stats, type ToolId } from "./IslandTools";
import { TodoTab } from "./Todo";
import { EMPTY_SETTINGS, prefsOf, SHORTCUTS, TAB_LABEL, type Settings, type Tab } from "./prefs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { notesSince } from "./whatsnew";
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
type Other = { app: string; title: string; artist: string }; // a second player that is also playing
type Snapshot = { media: Media | null; other?: Other | null; battery: { percent: number; charging: boolean } | null };
type Session = { agent: string; title: string; project: string; working: boolean; since: number; last: number; model: string };
type Agents = { sessions: Session[]; tokens_today: number };
/** wifi / bluetooth: null when there's no such radio. */
type Tools = { dark: boolean; mic_muted: boolean; awake: boolean; wifi?: boolean | null; bluetooth?: boolean | null };
/** One line in the Recent tab. `path`: a finished download, opened on click. */
type Recent = { kind: "notification" | "download" | "agent" | "timer" | "focus"; text: string; at: number; path?: string };
type Hud = {
  kind: "volume" | "brightness" | "power" | "timer" | "focus" | "download" | "agent" | "notification" | "device" | "mic" | "color";
  level: number;
  flag: boolean;
  text?: string;
  icon?: string;
  swatch?: string; // a picked colour, shown in place of the icon
};

/** rest: the small pill. peek: hovering, a wider pill with the live thing and its controls.
 *  open: clicked, the full panel. */
type Mode = "rest" | "peek" | "open";

// Must match .pill, .bubble .pill.rest, .pill.peek and .pill.open in island.css (MAX in
// lib.rs is the open pill plus the shortcut columns; resting() there knows rest sizes).
const COLLAPSED = { w: 200, h: 36 };
const BUBBLE = { w: 36, h: 36 };
const PEEK = { w: 360, h: 36 };
const EXPANDED = { w: 420, h: 268 };
const sizeOf = (m: Mode, bubble: boolean) => (m === "open" ? EXPANDED : m === "peek" ? PEEK : bubble ? BUBBLE : COLLAPSED);
/** Hover this long before peeking, so passing over the top edge on the way to a tab doesn't. */
const PEEK_DELAY = 120;
/** A tucked pill sliding out: about its transform transition (.tucked in island.css). */
const REVEAL = 480;
const PRESETS = [1, 5, 15, 25];
const RECENT_MAX = 20;
const NO_LINES: Line[] = [];

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
  display: ICONS.brightness,
  network: ICONS.wifi,
  power: ICONS.shutdown,
  color: ICONS.picker,
  camera: ICONS.camera,
};
const HUD_ICON: Partial<Record<Hud["kind"], string>> = {
  notification: ICONS.bell,
  agent: ICONS.agent,
  download: ICONS.download,
  timer: ICONS.timer,
  focus: ICONS.timer,
  device: ICONS.bluetooth,
};


/** Text that scrolls when it doesn't fit: one pass, a pause, again. Not a running CSS
 *  animation, which keeps the island repainting (and costs CPU) even while it's paused. */
const MARQUEE_GAP = 40;
const Marquee = ({ className, children }: { className: string; children: React.ReactNode }) => {
  const box = useRef<HTMLSpanElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const b = box.current!;
    const first = b.firstElementChild!.firstElementChild as HTMLElement;
    const check = () => setOver(first.offsetWidth > b.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(b);
    return () => ro.disconnect();
  }, [children]);
  useEffect(() => {
    if (!over) return;
    const track = box.current!.firstElementChild as HTMLElement;
    const d = (track.firstElementChild as HTMLElement).offsetWidth + MARQUEE_GAP;
    let t = 0;
    let a: Animation | null = null;
    const pass = () => {
      a = track.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-d}px)` }], { duration: (d / 35) * 1000 });
      a.onfinish = () => (t = window.setTimeout(pass, 2500));
    };
    t = window.setTimeout(pass, 2000);
    return () => {
      clearTimeout(t);
      a?.cancel();
    };
  }, [over, children]);
  return (
    <span ref={box} className={`${className} marquee${over ? " over" : ""}`}>
      <span className="mq-track">
        <span>{children}</span>
        {over && <span aria-hidden>{children}</span>}
      </span>
    </span>
  );
};

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
  // The bubble widens to the plain pill while a HUD (volume, power) needs the room.
  const bubble = settings.style === "bubble" && !hud;
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;
  const [timerEnd, setTimerEnd] = useState<number | null>(null);
  const [powerTimer, setPowerTimer] = useState<PowerTimer | null>(null); // sleep / shut down, set on the Power page
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
  const [tool, setTool] = useState<ToolId | null>(null); // a shortcut's page (IslandTools), over the tabs
  const [showLyrics, setShowLyrics] = useState(() => load("showLyrics", true));
  const [volume, setVolume] = useState(0);
  const [muted, setMuted] = useState(false);
  const draggingVolume = useRef(false); // Windows echoes each change back; don't let it tug the knob
  const lyricsCache = useRef(new Map<string, Line[]>());
  const [away, setAway] = useState(false);
  const [fullscreen, setFullscreen] = useState(false); // a fullscreen video or browser: tuck
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
  const removeRecent = (at: number) =>
    setRecent((cur) => {
      const next = cur.filter((r) => r.at !== at);
      save("recent", next);
      return next;
    });

  const showHud = (h: Hud, ms = 1600) => {
    setHud(h);
    clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setHud(null), ms);
  };

  // ---------- window region and the three states ----------

  // What the window region currently allows; it must cover the pill before the pill grows
  // into it, and shrinks only once the pill has finished shrinking.
  const region = useRef({ ...COLLAPSED, open: false, out: false });
  const intent = useRef<Mode>("rest");
  // Tucked (auto-hide, or a fullscreen video): at rest the pill hides in the top edge until
  // the mouse comes near, then comes out small; staying on it peeks as usual.
  const tucked = !!settings.auto_hide || fullscreen;
  const [out, setOut] = useState(false);
  const outRef = useRef(out);
  const setRegion = (s: { w: number; h: number }, open: boolean) => {
    region.current = { ...s, open, out: outRef.current };
    const p = prefsRef.current;
    return invoke("resize", { w: s.w, h: s.h, left: open ? p.left.length : 0, right: open ? p.right.length : 0, out: outRef.current });
  };
  const comeOut = (on: boolean) => {
    outRef.current = on;
    if (on) setRegion(sizeOf("rest", bubbleRef.current), false).then(() => outRef.current && setOut(true));
    else {
      setOut(false); // the region follows once it has slid away (onTransitionEnd)
      // Left before it came out, so no transition ends: shrink the region anyway.
      window.setTimeout(() => {
        if (!outRef.current && region.current.out && intent.current === "rest") setRegion(sizeOf("rest", bubbleRef.current), false);
      }, REVEAL);
    }
  };
  function go(next: Mode) {
    intent.current = next;
    clearTimeout(hoverTimer.current);
    const t = sizeOf(next, bubbleRef.current);
    const r = region.current;
    if (t.w > r.w || t.h > r.h || (next === "open" && !r.open)) {
      // Only if nothing else was asked for while the region grew (the mouse may have left).
      setRegion(t, next === "open").then(() => intent.current === next && setMode(next));
    } else setMode(next);
  }
  function collapseSoon(ms: number) {
    clearTimeout(leave.current);
    leave.current = window.setTimeout(() => {
      go("rest");
      if (outRef.current) comeOut(false);
    }, ms);
  }
  const onEnter = () => {
    hovering.current = true;
    clearTimeout(leave.current);
    if (intent.current !== "rest") return;
    // Tucked away: come out first, and only peek (or open) if the mouse stays once it's out.
    const hidden = tucked && !outRef.current;
    if (hidden) comeOut(true);
    if (prefs.openOn === "hover" && !hidden) return go("open");
    clearTimeout(hoverTimer.current);
    const next = prefs.openOn === "hover" ? "open" : "peek";
    hoverTimer.current = window.setTimeout(() => go(next), hidden ? REVEAL + PEEK_DELAY : PEEK_DELAY);
  };
  const menuOpen = useRef(false); // the right-click menu is showing
  const typing = useRef(false); // typing a to-do: stay open even if the mouse wanders off
  const hovering = useRef(false);
  const onTyping = (on: boolean) => {
    typing.current = on;
    if (!on && !hovering.current) collapseSoon(400);
  };
  const onLeave = () => {
    hovering.current = false;
    if (menuOpen.current || typing.current) return;
    clearTimeout(hoverTimer.current);
    collapseSoon(intent.current === "open" ? 400 : 150);
  };
  // Shrinking: the region follows once the pill's size transition ends.
  const onTransitionEnd = (e: React.TransitionEvent) => {
    if (e.target !== e.currentTarget || !["width", "height", "transform"].includes(e.propertyName)) return;
    const t = sizeOf(mode, bubble);
    const r = region.current;
    if (t.w !== r.w || t.h !== r.h || r.open !== (mode === "open") || r.out !== outRef.current) setRegion(t, mode === "open");
  };
  // The resting bubble widening (a HUD, or the style changed in Settings): grow the region
  // with it. Shrinking is left to onTransitionEnd.
  useEffect(() => {
    if (mode === "rest" && !bubble && region.current.w < COLLAPSED.w) setRegion(COLLAPSED, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the bubble changes
  }, [bubble]);

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
        // Volume keys and the Windows flyout move the music page's slider too.
        if (kind === "volume" && !draggingVolume.current) {
          setVolume(level);
          setMuted(flag);
        }
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
      listen<boolean>("tucked", (e) => setFullscreen(e.payload)),
      // Click-through mode (watch_click_through in lib.rs; it also fades the window): treat
      // clicks starting to pass through as the mouse leaving.
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
      listen<PowerTimer | null>("power_timer", (e) => setPowerTimer(e.payload)),
      listen<string>("color_picked", (e) => showHud({ kind: "color", level: 1, flag: false, text: `Copied ${e.payload}`, swatch: e.payload }, 3000)),
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

  // Sleep / shut down timer: Rust holds it and acts on it; the pill counts down and warns
  // a minute before, so there's time to cancel it on the Power page.
  useEffect(() => {
    invoke<{ timer: PowerTimer | null }>("power").then((p) => setPowerTimer(p.timer)); // after a reload
  }, []);
  useEffect(() => {
    if (!powerTimer) return;
    let warned = powerTimer.at - Date.now() <= 60_000;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (!warned && powerTimer.at - t <= 60_000) {
        warned = true;
        const sleep = powerTimer.action === "sleep";
        showHud({ kind: "timer", level: 1, flag: true, text: `${sleep ? "Sleeping" : "Shutting down"} in 1 minute`, icon: sleep ? ICONS.sleep : ICONS.shutdown }, 8000);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [powerTimer]);

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
  const pomoJump = (ph: P.Phase, round: number) => setPomo((p) => P.jump(p, ph, round, cfg));
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
  useEffect(() => {
    if (mode === "rest") setTool(null); // a shortcut's page lasts until the island closes
  }, [mode]);
  // What's new: after an update, the next time the island opens it shows the new version's
  // notes, once. A first install just remembers the version.
  const [newsPending, setNewsPending] = useState(false);
  useEffect(() => {
    getVersion().then((v) => {
      const seen = load<string | null>("seen-version", null);
      if (!seen) return save("seen-version", v);
      if (notesSince(seen, v).length) {
        setNewsPending(true);
        showHud({ kind: "notification", level: 1, flag: false, text: `Updated to Pulo ${v} · open to see what's new`, icon: ICONS.info }, 8000);
      } else if (seen !== v) save("seen-version", v);
    }, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, at start
  }, []);
  useEffect(() => {
    if (mode !== "open" || !newsPending) return;
    setNewsPending(false);
    setTool("whatsnew");
    getVersion().then((v) => save("seen-version", v)); // seen once it's on screen
  }, [mode, newsPending]);
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
    // On opening, so it's right before the music page shows rather than jumping from 0.
    if (isOpen)
      invoke<[number, boolean]>("volume").then(([l, m]) => {
        setVolume(l);
        setMuted(m);
      });
  }, [isOpen]);
  // Shortcuts changed in Settings while open: the region needs the new button count.
  useEffect(() => {
    if (mode === "open") setRegion(EXPANDED, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the counts change
  }, [prefs.left.length, prefs.right.length]);

  const tabOn: Record<Tab, boolean> = { now: true, recent: true, focus: focusOn, agents: agentsOn, todo: has("todo"), tools: toolsOn };
  const tabs = prefs.tabs.filter((t) => tabOn[t]); // in the order chosen in Settings
  const shown: Tab = tabs.includes(tab) ? tab : "now";
  // System stats: sampled only while someone is looking at them.
  const statsVisible = mode === "open" && !tool && (shown === "tools" || (shown === "now" && !musicPage));
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
          {hud.swatch ? <span className="swatch" style={{ background: hud.swatch }} /> : <Icon d={hud.icon ?? HUD_ICON[hud.kind] ?? ICONS.bell} />}
          <span className={`hud-text${hud.flag ? " low" : ""}`}>{hud.text}</span>
        </>
      )}
    </div>
  );

  const powerLeft = powerTimer && `${powerTimer.action === "sleep" ? "Sleep" : "Off"} ${clockLeft(powerTimer.at - now)}`;
  const status = remaining ?? powerLeft ?? (pomoRunning ? fmt(pomoLeft) : null) ?? soon;
  const statusCls = remaining || soon ? "accent" : powerLeft ? "" : phaseCls;

  // One hover area for the pill and the shortcut columns beside it, so moving onto a
  // shortcut doesn't close the island. The window region keeps the rest click-through.
  const side = (items: string[]) => (
    <div className="side" aria-hidden={!isOpen}>
      {items.map((target) => (
        <button
          key={target}
          className={`shortcut${tool === target ? " on" : ""}`}
          aria-label={SHORTCUTS[target]}
          title={SHORTCUTS[target]}
          tabIndex={isOpen ? 0 : -1}
          onClick={() => (isTool(target) ? setTool(tool === target ? null : target) : invoke("launch", { target }))}
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
  // Volume as Windows keeps it: a level, and muted on top of it (muting doesn't lose the level).
  const changeVolume = (v: number) => {
    const level = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
    setVolume(level);
    setMuted(level <= 0); // set_volume unmutes when turned up, mutes at 0
    invoke("set_volume", { level });
  };
  const toggleMute = () => {
    if (muted && volume <= 0) return changeVolume(0.3); // nothing to go back to
    setMuted(!muted);
    invoke("set_muted", { on: !muted });
  };
  const shuffleBtn = media && media.shuffle !== null && (
    <button className={`icon-btn${media.shuffle ? " on" : ""}`} aria-label="Shuffle" aria-pressed={media.shuffle} onClick={() => invoke("media", { action: "shuffle" })}>
      <Icon d={ICONS.shuffle} size={16} />
    </button>
  );
  const repeatBtn = media && media.repeat !== null && (
    <button
      className={`icon-btn${media.repeat !== "none" ? " on" : ""}`}
      aria-label={`Repeat: ${media.repeat === "track" ? "this song" : media.repeat === "list" ? "all" : "off"}`}
      onClick={() => invoke("media", { action: "repeat" })}
    >
      <Icon d={media.repeat === "track" ? ICONS.repeatOne : ICONS.repeat} size={16} />
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
        {art ? <img className="art small" src={art} alt="" key={art} /> : <div className="art small empty"><Icon d={ICONS.music} size={18} /></div>}
        <div className="meta song" key={media.title}>
          <Marquee className="title">{media.title || "Unknown title"}</Marquee>
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
        {shuffleBtn}
        {repeatBtn}
        {/* Volume: the speaker mutes and unmutes, the wheel nudges it, the number says where it is. */}
        <div className={`volume-row${muted ? " muted" : ""}`} title="Scroll to change the volume" onWheel={(e) => changeVolume(volume + (e.deltaY < 0 ? 0.02 : -0.02))}>
          <button className="icon-btn" aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} title={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
            <Icon d={muted || volume <= 0 ? ICONS.mute : volume < 0.5 ? ICONS.volume : ICONS.volumeHigh} size={16} />
          </button>
          <input
            type="range"
            className="slider volume"
            min={0}
            max={1}
            step={0.02}
            value={volume}
            aria-label="Volume"
            aria-valuetext={muted ? "Muted" : `${Math.round(volume * 100)}%`}
            style={{ "--pct": `${volume * 100}%` } as React.CSSProperties}
            onPointerDown={() => (draggingVolume.current = true)}
            onPointerUp={() => (draggingVolume.current = false)}
            onPointerCancel={() => (draggingVolume.current = false)}
            onChange={(e) => changeVolume(+e.target.value)}
          />
          <span className="vol-pct mono" aria-hidden="true">
            {Math.round(volume * 100)}
          </span>
        </div>
        {lyricsBtn}
      </div>
      )}
    </div>
  );
  // The music page has the whole panel: no tabs (Back returns), the cover's colour behind it.
  const musicOpen = isOpen && shown === "now" && musicPage && !!media;

  // Changing pages: the new one slides in from the side it's on (tabs to the right come from
  // the right; the music page is deeper than Now, so it comes from the right and Back
  // returns from the left). Keying the tab body on the page replays a one-shot animation.
  const pageKey = tool ? `tool-${tool}` : shown === "now" && musicPage && media ? "music" : shown;
  const page = useRef<{ key: string; dir: "" | "fwd" | "back" }>({ key: pageKey, dir: "" });
  if (page.current.key !== pageKey) {
    const at = (k: string) => (k.startsWith("tool-") ? tabs.length + 1 : k === "music" ? tabs.length : tabs.indexOf(k as Tab));
    page.current = { key: pageKey, dir: at(pageKey) > at(page.current.key) ? "fwd" : "back" };
  }
  // The highlight behind the current tab glides to the next one instead of jumping.
  const tabsRef = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number; slide: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>(".tab.on");
    setInd((p) => (el ? { x: el.offsetLeft, w: el.offsetWidth, slide: !!p } : null));
  }, [shown, tabs.join(), musicOpen, tool]); // eslint-disable-line react-hooks/exhaustive-deps

  const nowTab = musicPage && musicEl ? musicEl : (
    <>
      {media ? (
        // A card in the cover's colour: the song on top, its position, then the controls centred.
        <div className="player">
          <div className="media">
            {/* The song itself opens the music page, as on a phone; the art sinks a little while paused. */}
            <button className={`art-btn${playing ? "" : " paused"}`} aria-label="Music: lyrics, volume" tabIndex={isOpen ? 0 : -1} onClick={() => setMusicPage(true)}>
              {art ? <img className="art" src={art} alt="" key={art} /> : <div className="art empty"><Icon d={ICONS.music} size={24} /></div>}
            </button>
            <div className="meta song" key={media.title} onClick={() => setMusicPage(true)}>
              <Marquee className="title">{media.title || "Unknown title"}</Marquee>
              <div className="sub">{[media.artist, media.album].filter(Boolean).join(" · ")}</div>
            </div>
            <div className="player-corner">
              {isOpen && playing && has("equalizer") && <Equalizer />}
              <button className="icon-btn" aria-label="Music: lyrics, volume" title="Lyrics and volume" tabIndex={isOpen ? 0 : -1} onClick={() => setMusicPage(true)}>
                <Icon d={ICONS.lyrics} size={16} />
              </button>
            </div>
          </div>
          {progressEl}
          <div className="player-controls">
            {/* Empty slots keep the transport centred when the player has no shuffle or repeat. */}
            <span className="slot-btn">{shuffleBtn}</span>
            {transport}
            <span className="slot-btn">{repeatBtn}</span>
          </div>
          {snap.other && (
            <button className="also" title={`Show ${snap.other.app} instead`} onClick={() => invoke("media", { action: "swap" })}>
              <span className="also-text">
                Also playing · {snap.other.app} — {[snap.other.title, snap.other.artist].filter(Boolean).join(" · ")}
              </span>
              <Icon d={ICONS.swap} size={14} />
            </button>
          )}
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
        {remaining
          ? quickTimer
          : stats && stats.cpu >= 0 && (
              <span className="usage mono">
                CPU {Math.round(stats.cpu)}% · RAM {stats.mem}%{stats.gpu >= 0 && ` · GPU ${Math.round(stats.gpu)}%`}
              </span>
            )}
      </div>
    </>
  );

  const roundNow = Math.min(pomo.phase === "focus" ? pomo.round + 1 : pomo.round, cfg.every);
  // The cycle as segments sized by length: focus, break, focus, ... long break. `round` is the
  // focus rounds finished before that segment, which is what P.jump needs to land on it.
  const cycle = Array.from({ length: cfg.every }, (_, i) => [
    { phase: "focus" as P.Phase, round: i },
    { phase: (i === cfg.every - 1 ? "long" : "short") as P.Phase, round: i + 1 },
  ]).flat();
  // A break reached by skipping a focus round has round 0; show it after the first focus.
  const atSeg = Math.min(cycle.length - 1, pomo.phase === "focus" ? pomo.round * 2 : Math.max(1, pomo.round * 2 - 1));
  const nextPhase = cycle[(atSeg + 1) % cycle.length].phase;
  const segName = (s: (typeof cycle)[number]) =>
    s.phase === "focus" ? `Focus, round ${s.round + 1}` : s.phase === "long" ? "Long break" : `Break after round ${s.round}`;
  const focusTab = (
    <>
      <div className="pomo">
        <div className="pomo-head">
          <span className={phaseCls}>
            {P.LABEL[pomo.phase]} · Round {roundNow} of {cfg.every}
          </span>
          {doneToday > 0 && <span>{doneToday} done today</span>}
        </div>
        <div className="pomo-main">
          <div>
            <div className={`pomo-time mono${pomoActive && !pomoRunning ? " paused" : ""}`}>{fmt(pomoLeft)}</div>
            <div className="pomo-hint">
              {pomoRunning ? `until ${hm(now + pomoLeft)}` : pomoActive ? "Paused" : `${cfg[pomo.phase]} minutes`} · then {P.LABEL[nextPhase].toLowerCase()}
            </div>
          </div>
          <div className="pomo-controls">
            <button aria-label="Start the cycle over" title="Start the cycle over" onClick={pomoReset}>
              <Icon d={ICONS.reset} size={18} />
            </button>
            <button className={`pomo-play ${phaseCls}${pomoRunning ? " running" : ""}`} aria-label={pomoRunning ? "Pause" : pomoActive ? "Resume" : "Start"} onClick={pomoRunning ? pomoPause : pomoStart}>
              <Icon d={pomoRunning ? ICONS.pause : ICONS.play} size={22} />
            </button>
            <button aria-label={`Skip to ${P.LABEL[nextPhase].toLowerCase()}`} title={`Skip to ${P.LABEL[nextPhase].toLowerCase()}`} onClick={pomoSkip}>
              <Icon d={ICONS.next} size={18} />
            </button>
          </div>
        </div>
        {/* Past segments full, the current one filling, the rest empty. Click one to go there. */}
        <div className="cycle">
          {cycle.map((s, k) => (
            <button
              key={k}
              className={`seg ${s.phase === "focus" ? "accent" : "break"}${k === atSeg ? " now" : ""}`}
              style={{ flexGrow: cfg[s.phase], "--fill": `${k < atSeg ? 100 : k > atSeg ? 0 : (1 - pomoLeft / pomoTotal) * 100}%` } as React.CSSProperties}
              aria-label={`Go to ${segName(s).toLowerCase()}`}
              aria-current={k === atSeg ? "step" : undefined}
              title={`${segName(s)} · ${cfg[s.phase]} min`}
              onClick={() => k !== atSeg && pomoJump(s.phase, s.round)}
            />
          ))}
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
          // Working sessions first, then the most recently active.
          [...agents.sessions]
            .sort((a, b) => +working.includes(b) - +working.includes(a) || b.last - a.last)
            .map((s) => {
              const busy = working.includes(s);
              const meta = [s.title ? s.project : "", shortModel(s.model)].filter(Boolean).join(" · ");
              return (
                <div className={`agent-card${busy ? " busy" : ""}`} key={`${s.project}${s.since}`}>
                  <span className={`dot${busy ? " working" : " resting"}`} aria-hidden="true" />
                  <div className="agent-text">
                    <div className="agent-title">{s.title || s.project}</div>
                    <div className="agent-meta">{meta}</div>
                  </div>
                  <div className="agent-when">
                    <span className="agent-state">{busy ? "Working" : "Idle"}</span>
                    <span className="mono">{busy ? fmtDur(now - s.since) : fmtAgo(now - s.last)}</span>
                  </div>
                </div>
              );
            })
        ) : (
          <div className="empty-note">
            <Icon d={ICONS.agent} size={22} />
            No Claude Code sessions in the last day
          </div>
        )}
      </div>
      <div className="bar">
        <span className={working.length ? "more" : ""}>{working.length ? `${working.length} working` : agents.sessions.length ? "All idle" : ""}</span>
        <span className="mono">{fmtTokens(agents.tokens_today)} tokens today</span>
      </div>
    </>
  );

  // Toggles (pressed is a boolean), one-shot actions, and pages (tool ids) that open over the tabs.
  const tiles: [string, string, string, boolean | undefined][] = [
    ["wifi", "Wi-Fi", ICONS.wifi, !!tools.wifi],
    ["bluetooth", "Bluetooth", ICONS.bluetooth, !!tools.bluetooth],
    ["dark", "Dark mode", ICONS.moon, tools.dark],
    ["mic", tools.mic_muted ? "Mic muted" : "Mic on", tools.mic_muted ? ICONS.micOff : ICONS.mic, tools.mic_muted],
    ["awake", "Keep awake", ICONS.coffee, tools.awake],
    ["camera", "Camera", ICONS.camera, undefined],
    ["color", "Pick color", ICONS.picker, undefined],
    ["scratchpad", "Scratchpad", ICONS.note, undefined],
    ["display", "Display", ICONS.brightness, undefined],
    ["power", "Power", ICONS.shutdown, undefined],
    ["lock", "Lock", ICONS.lock, undefined],
    ["empty_bin", "Empty bin", ICONS.trash, undefined],
  ];
  const tile = (action: string) => {
    if (action === "scratchpad") invoke("launch", { target: "scratchpad" });
    else if (action === "color") {
      collapseSoon(0); // out of the picture first
      invoke("pick_color");
    } else if (isTool(action)) setTool(action);
    else runTool(action);
  };
  const toolsTab = (
    <>
      <div className="tools">
        {tiles.map(([action, label, icon, pressed]) => (
          <button
            key={action}
            className={`tile${pressed ? " on" : ""}${action === "mic" && pressed ? " warn" : ""}`}
            aria-pressed={pressed}
            onClick={() => tile(action)}
          >
            <Icon d={icon} size={18} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <button className="bar mono" title="Open Performance" onClick={() => setTool("task_manager")}>
        <span>
          CPU {stats && stats.cpu >= 0 ? `${Math.round(stats.cpu)}%` : "–"} · Memory {stats ? `${stats.mem}%` : "–"}
          {stats && stats.gpu >= 0 && ` · GPU ${Math.round(stats.gpu)}%`}
        </span>
        <span>{stats && stats.cpu >= 0 ? `↓ ${fmtRate(stats.down)}  ↑ ${fmtRate(stats.up)}` : ""}</span>
      </button>
    </>
  );

  const RECENT_ICON: Record<Recent["kind"], string> = {
    notification: ICONS.bell,
    download: ICONS.download,
    agent: ICONS.agent,
    timer: ICONS.timer,
    focus: ICONS.timer,
  };
  const dayLabel = (t: number) => {
    const d = new Date(t).toDateString();
    if (d === new Date(now).toDateString()) return "Today";
    if (d === new Date(now - 864e5).toDateString()) return "Yesterday";
    return new Date(t).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  };
  const recentDays = new Set(recent.map((r) => new Date(r.at).toDateString())).size;
  const recentTab = (
    <>
      <div className="recent-list">
        {recent.length ? (
          recent.map((r, i) => {
            // A day heading only once the list spans more than today.
            const day = dayLabel(r.at);
            const head = recentDays > 1 && (i === 0 || dayLabel(recent[i - 1].at) !== day);
            const inner = (
              <>
                <span className={`badge k-${r.kind}`}>
                  <Icon d={RECENT_ICON[r.kind]} size={14} />
                </span>
                <span className="recent-text">{r.text}</span>
              </>
            );
            return (
              <Fragment key={`${r.at}${r.text}`}>
                {head && <div className="recent-day">{day}</div>}
                <div className="recent-row">
                  {r.path ? (
                    <button className="recent-main" title={`Open ${r.path}`} onClick={() => invoke("open_path", { path: r.path })}>
                      {inner}
                    </button>
                  ) : (
                    <div className="recent-main">{inner}</div>
                  )}
                  <span className="recent-time">{fmtAgo(now - r.at)}</span>
                  <button className="recent-x" aria-label={`Remove ${r.text}`} title="Remove" onClick={() => removeRecent(r.at)}>
                    <Icon d={ICONS.close} size={12} />
                  </button>
                </div>
              </Fragment>
            );
          })
        ) : (
          <div className="empty-note">
            <Icon d={ICONS.bell} size={22} />
            Notifications, downloads and finished timers show up here
          </div>
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
      <Marquee className="peek-main">
        {media.title || "Unknown title"}
        {media.artist && <span className="dim"> · {media.artist}</span>}
      </Marquee>
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
      className={`island ${mode}${settings.style === "notch" ? " notch" : bubble ? " bubble" : ""}${tucked && !out ? " tucked" : ""}`}
      style={
        {
          "--tint": tint ?? undefined, // the notch's ears take it too
          // Tucked, the window sits on the screen's edge; out, the pill drops to the gap (apply_region).
          "--drop": tucked && settings.style !== "notch" ? `${settings.top_gap ?? 6}px` : undefined,
        } as React.CSSProperties
      }
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onContextMenu={(e) => {
        e.preventDefault();
        // A native menu at the cursor (quick_menu in lib.rs). It takes the mouse, which reads
        // as leaving: stay as we are until it closes (the call returns then), and collapse
        // afterwards only if the mouse isn't back on the island.
        menuOpen.current = true;
        clearTimeout(leave.current);
        clearTimeout(hoverTimer.current);
        invoke("quick_menu").finally(() => {
          menuOpen.current = false;
          if (!document.querySelector(".island:hover")) collapseSoon(400);
        });
      }}
      // Clicking inside the webview drops the window's transparency (white corners); restore it.
      onPointerDown={() => invoke("refresh_transparency")}
      onPointerUp={() => invoke("refresh_transparency")}
    >
      {side(prefs.left)}
      <div
        className={`pill ${mode}${musicOpen && tint ? " tinted" : ""}`}
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
                  <Equalizer className={`wave${working.length ? " working" : ""}`} fps={12} />
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
          {tabs.length > 1 && !musicOpen && !tool && (
            <div className="tabs" role="tablist" ref={tabsRef}>
              {ind && <span className={`tab-ind${ind.slide ? " slide" : ""}`} style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} aria-hidden="true" />}
              {tabs.map((t) => (
                <button key={t} role="tab" aria-selected={t === shown} className={`tab${t === shown ? " on" : ""}`} tabIndex={isOpen ? 0 : -1} onClick={() => {
                    setTool(null);
                    pickTab(t);
                  }}>
                  {TAB_LABEL[t]}
                </button>
              ))}
            </div>
          )}
          <div className={`tab-body${page.current.dir ? ` page-${page.current.dir}` : ""}`} key={pageKey}>
            {tool ? (
              <ToolPage tool={tool} ago={fmtAgo} onBack={() => setTool(null)} onDone={() => collapseSoon(0)} />
            ) : shown === "now"
              ? nowTab
              : shown === "recent"
                ? recentTab
                : shown === "focus"
                  ? focusTab
                  : shown === "agents"
                    ? agentsTab
                    : shown === "todo"
                      ? <TodoTab open={isOpen} onTyping={onTyping} />
                      : toolsTab}
          </div>
        </div>
      </div>
      {settings.style === "notch" && <div className={`ears${musicOpen && tint ? " tinted" : ""}`} />}
      {side(prefs.right)}
    </div>
  );
}
