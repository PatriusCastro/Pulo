// Stand-in for @tauri-apps/api on the website: the real island UI, driven by a pretend PC.
// Keeps state so the controls work: play, skip, seek, shuffle, repeat, volume, tools.
// Songs, lyrics and covers are made up, so the page shows nothing it doesn't own.

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();
export const emit = (name: string, payload: unknown = null) => handlers.get(name)?.forEach((f) => f({ payload }));

export async function listen(name: string, f: Handler) {
  handlers.set(name, [...(handlers.get(name) ?? []), f]);
  return () => handlers.set(name, (handlers.get(name) ?? []).filter((g) => g !== f));
}
export const getCurrentWebview = () => ({ onDragDropEvent: async () => () => {} });

const SONGS = [
  {
    title: "Island Time", artist: "The Locals", album: "Top of the Screen", ms: 168_000,
    colors: ["#ff9a5a", "#d9482b", "#5b1f3a"],
    lines: ["Turn the volume low", "The tide is coming in", "We live at the top of the screen", "Where the notifications swim", "", "Hover once and we're open", "Click again, we're home", "Island time, island time", "Nothing here but you and me", "And a download coming in"],
  },
  {
    title: "Low Tide", artist: "Harbor Lights", album: "Shoreline", ms: 192_000,
    colors: ["#7fd6e8", "#1f7a9c", "#0b2540"],
    lines: ["Headphones at twelve percent", "Singing while they can", "The meeting's in fifteen", "So I'm finishing the plan", "", "Low tide, low tide", "Everything I need in sight", "Low tide, low tide", "Sitting at the top tonight"],
  },
  {
    title: "Focus Mode", artist: "Pomodoro Club", album: "Twenty-Five", ms: 150_000,
    colors: ["#c8f080", "#3ddc84", "#0d3b2a"],
    lines: ["Ring is running down", "One more round to go", "Breathe in on the break", "Then back into the flow", "", "Focus mode, focus mode", "Four dots on the road", "Focus mode, focus mode", "Lighten up the load"],
  },
];

let i = 0;
let playing = true;
let pos = 41_000;
let at = Date.now();
let shuffle = false;
let repeat: "none" | "list" | "track" = "none";
let rev = 1;
let volume = 0.62;
const tools = { dark: true, mic_muted: false, awake: false };

const now = () => (playing ? Math.min(SONGS[i].ms, pos + Date.now() - at) : pos);
const media = () => ({
  title: SONGS[i].title, artist: SONGS[i].artist, album: SONGS[i].album, playing, art_rev: rev,
  duration_ms: SONGS[i].ms, position_ms: pos, position_at: at, can_seek: true, shuffle, repeat,
});
const snapshot = () => ({ media: media(), battery: { percent: 76, charging: false } });
const publish = () => emit("state", snapshot());

function go(k: number) {
  i = shuffle && k !== i ? Math.floor(Math.random() * SONGS.length) : (k + SONGS.length) % SONGS.length;
  pos = 0;
  at = Date.now();
  rev++;
  publish();
}

// The song ends: next one, same one, or stop, like a real player.
setInterval(() => {
  if (!playing || now() < SONGS[i].ms) return;
  if (repeat === "track") { pos = 0; at = Date.now(); publish(); }
  else if (i < SONGS.length - 1 || repeat === "list" || shuffle) go(i + 1);
  else { playing = false; pos = SONGS[i].ms; publish(); }
}, 500);

// Live levels for the equalizer, as Rust sends while capturing audio.
// Each bar eases toward a new level a few times a second, so it reads as music, not noise.
let eqTimer: number | undefined;
const bars = [0.4, 0.4, 0.4, 0.4, 0.4];
const goal = [0.4, 0.4, 0.4, 0.4, 0.4];
let frame = 0;
function equalizer(on: boolean, fps = 30) {
  clearInterval(eqTimer);
  if (!on) return;
  eqTimer = window.setInterval(() => {
    if (frame++ % 6 === 0) goal.forEach((_, k) => (goal[k] = playing ? 0.2 + Math.random() * 0.7 : 0));
    bars.forEach((v, k) => (bars[k] = v + (goal[k] - v) * 0.18));
    emit("eq", [...bars]);
  }, 1000 / Math.min(fps, 30));
}

async function cover(c: string[]) {
  const cv = new OffscreenCanvas(300, 300);
  const g = cv.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, 300);
  sky.addColorStop(0, c[0]);
  sky.addColorStop(0.6, c[1]);
  sky.addColorStop(1, c[2]);
  g.fillStyle = sky;
  g.fillRect(0, 0, 300, 300);
  g.fillStyle = "rgba(255,240,200,.85)";
  g.beginPath();
  g.arc(150, 168, 58, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = c[2];
  g.fillRect(0, 190, 300, 110);
  g.fillStyle = "#050505";
  g.beginPath();
  g.roundRect(96, 181, 108, 22, 11);
  g.fill();
  return (await cv.convertToBlob()).arrayBuffer();
}

const lrc = (lines: string[]) => lines.map((l, k) => `[${String(Math.floor((4 + k * 5) / 60)).padStart(2, "0")}:${String((4 + k * 5) % 60).padStart(2, "0")}.00]${l}`).join("\n");

function ics() {
  const t = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const s = new Date(Date.now() + 38 * 60_000);
  const e = new Date(s.getTime() + 30 * 60_000);
  return `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:demo\nSUMMARY:Design review\nDTSTART:${t(s)}\nDTEND:${t(e)}\nEND:VEVENT\nEND:VCALENDAR`;
}

export async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (cmd) {
    case "snapshot":
      return snapshot();
    case "media": {
      const a = args.action as string;
      if (a === "toggle") { pos = now(); at = Date.now(); playing = !playing; publish(); }
      else if (a === "next") go(i + 1);
      else if (a === "prev") (now() > 3000 ? ((pos = 0), (at = Date.now()), publish()) : go(i - 1));
      else if (a === "seek") { pos = Math.max(0, Math.min(SONGS[i].ms, Number(args.value))); at = Date.now(); publish(); }
      else if (a === "shuffle") { shuffle = !shuffle; publish(); }
      else if (a === "repeat") { repeat = repeat === "none" ? "list" : repeat === "list" ? "track" : "none"; publish(); }
      return null;
    }
    case "media_art":
      return cover(SONGS[i].colors);
    case "lyrics":
      return lrc(SONGS.find((s) => s.title === args.title)?.lines ?? []);
    case "equalizer":
      return equalizer(!!args.on, Number(args.fps) || 30);
    case "volume":
      return volume;
    case "set_volume":
      volume = Number(args.level);
      return null;
    case "tools_state":
      return { ...tools };
    case "tool": {
      const a = args.action as string;
      if (a === "dark") tools.dark = !tools.dark;
      if (a === "mic") tools.mic_muted = !tools.mic_muted;
      if (a === "awake") tools.awake = !tools.awake;
      return { ...tools };
    }
    case "stats":
      return { cpu: 12 + Math.random() * 10, mem: Math.round(48 + Math.random() * 3), down: 120_000 * Math.random(), up: 20_000 * Math.random() };
    case "calendar":
      return ics();
    case "agents":
      return {
        sessions: [{ agent: "claude", title: "Make the island follow the mouse", project: "pulo", working: true, since: Date.now() - 260_000, last: Date.now(), model: "opus" }],
        tokens_today: 184_200,
      };
    case "devices":
      return [{ name: "Buds", percent: 64, kind: "headphones" }, { name: "Mouse", percent: 41, kind: "mouse" }];
    case "get_settings":
      return { calendar_url: "demo", lyrics: true, off: [], ui: {} };
    case "hotkey_ok":
      return true;
    default:
      return null; // resize, launch, open_path, drag_out…: nothing to do in a web page
  }
}

// A little life while the visitor watches: a download finishes.
setTimeout(() => emit("download", "C:\\Users\\you\\Downloads\\boarding-pass.pdf"), 9000);
