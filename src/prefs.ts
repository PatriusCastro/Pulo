// Settings shared by the island and the Settings window. Saved by Rust in settings.json:
// `off` and `lyrics` are enforced there, `ui` is ours alone.
import { DEFAULTS as POMODORO, type Config } from "./pomodoro";

/** Settings' feature groups, in the order it shows them. */
export const GROUPS = { music: "Music", happening: "What's happening", work: "Getting things done", island: "The island" } as const;

/** What a feature keeps doing while it's on, from its loop in lib.rs. */
export const COST = {
  idle: "Nothing in the background",
  waits: "Waits for changes in the background",
  timer: "Checks on a timer in the background",
} as const;

/** Features that can be turned off: [id, label, help, group, cost], in the order Settings lists them. */
export const FEATURES = [
  ["media", "Now playing", "Track, album art and controls", "music", "waits"],
  ["equalizer", "Live equalizer", "Bars that follow the music, in the pill and the open island", "music", "timer"],
  ["notifications", "Notifications", "New Windows notifications appear in the island (MSIX build only)", "happening", "timer"],
  ["downloads", "Downloads", "Finished downloads appear and go to Recent", "happening", "waits"],
  ["calendar", "Calendar", "Next event, and a heads-up 15 minutes before", "happening", "timer"],
  ["devices", "Device batteries", "Bluetooth mouse, keyboard and headphones", "happening", "timer"],
  ["agents", "AI agents", "Claude Code and Codex sessions, and a notice when a long task finishes", "work", "waits"],
  ["focus", "Focus timer", "Pomodoro rounds, a stopwatch and a timer", "work", "idle"],
  ["todo", "To Do", "A checklist tab in the island", "work", "idle"],
  ["tools", "Quick tools", "Wi-Fi, Bluetooth, dark mode, mic mute, keep awake, camera, color picker, lock, Recycle Bin, and a light while an app uses the camera or mic", "work", "idle"],
  ["hotkey", "Keyboard shortcut", "Ctrl+Alt+Space opens and closes the island", "island", "waits"],
  ["pet", "Pet", "The little sprout in the pill", "island", "idle"],
] as const;
export type Feature = (typeof FEATURES)[number][0];

/** One-click starting points: each turns on what it lists and turns off the rest. */
export const PRESETS: [id: string, label: string, help: string, on: Feature[]][] = [
  ["music", "Music", "Now playing, the equalizer, the shortcut and the pet", ["media", "equalizer", "hotkey", "pet"]],
  ["work", "Work", "Calendar, notifications, AI agents, focus, To Do and tools", ["notifications", "calendar", "agents", "focus", "todo", "tools", "hotkey"]],
  ["light", "Light", "Only what does nothing in the background", FEATURES.filter((f) => f[4] === "idle").map((f) => f[0])],
];

/** Island shortcuts. Must match the list in `launch` (lib.rs). */
export const SHORTCUTS: Record<string, string> = {
  settings: "Pulo settings",
  mixer: "Volume mixer",
  task_manager: "Task Manager",
  calculator: "Calculator",
  screenshot: "Screenshot",
  explorer: "File Explorer",
  clipboard: "Clipboard history",
  scratchpad: "Scratchpad",
  display: "Display",
  network: "Wi-Fi & Bluetooth",
  power: "Power",
  color: "Color picker",
  camera: "Camera mirror",
};
/** Buttons that fit in one side column. Also MAX_SHORTCUTS in lib.rs. */
export const MAX_SHORTCUTS = 5;

/** Tabs of the open island, in their default order. */
export const TAB_LABEL = { now: "Now", recent: "Recent", focus: "Focus", agents: "Agents", todo: "To Do", tools: "Tools" } as const;
export type Tab = keyof typeof TAB_LABEL;
const TABS = Object.keys(TAB_LABEL) as Tab[];

/** How the island looks. Rust reads it too, for the window's shape and place (style in lib.rs). */
export const STYLES = [
  ["pill", "Pill", "Floats just below the top of the screen"],
  ["notch", "Notch", "Grows out of the top edge of the screen"],
  ["bubble", "Bubble", "A small dot until you point at it"],
] as const;

/** How the island goes to another screen (.moving / .arriving in island.css). */
export const MOVES = [
  ["slide", "Slide"],
  ["fade", "Fade"],
  ["pop", "Pop"],
] as const;

/** The island's surface (.mat-* in island.css, previews .m-* in settings.css). */
export const MATERIALS = [
  ["black", "Black", "Solid, the same over anything"],
  ["glass", "Glass", "Clear: what's behind shows through"],
  ["frosted", "Frosted", "Softer, with a fine grain"],
] as const;

/** The island's accent (--accent): kept to white and green. Each takes dark text. (No grey:
 *  it matched --dim, so switched-on icons read as off.) */
export const ACCENTS = [
  ["white", "White", "#f5f5f5"],
  ["green", "Green", "#3ddc84"],
] as const;
export const accentOf = (id: string) => ACCENTS.find((a) => a[0] === id)?.[2] ?? ACCENTS[0][2];

export type Prefs = {
  openOn: "click" | "hover"; // click: hovering only peeks; hover: hovering opens it fully
  move: (typeof MOVES)[number][0];
  material: (typeof MATERIALS)[number][0];
  accent: (typeof ACCENTS)[number][0];
  // The resting pill's time and dot (the pet is its own feature). Alerts show regardless.
  showTime: boolean;
  showDot: boolean;
  idleTuck: boolean; // tuck into the top edge after a minute untouched
  left: string[];
  right: string[];
  tabs: Tab[];
  pomodoro: Config;
};

export const DEFAULT_PREFS: Prefs = {
  openOn: "click",
  move: "slide",
  material: "black",
  accent: "white",
  showTime: true,
  showDot: true,
  idleTuck: false,
  left: ["settings", "mixer", "task_manager"],
  right: ["calculator", "screenshot", "explorer", "clipboard"],
  tabs: TABS,
  pomodoro: POMODORO,
};

export type Settings = {
  calendar_url: string;
  lyrics: boolean;
  off: string[];
  ui: Partial<Prefs> | null;
  click_through?: boolean;
  show_in_screenshots?: boolean;
  top_gap?: number | null;
  style?: string; // STYLES; anything else is "pill"
  auto_hide?: boolean;
  hide_fullscreen?: boolean; // hidden, not tucked, over full-screen videos
  hide_browsers?: boolean; // hidden while a browser is in front
  hide_maximized?: boolean; // hidden while the window in front is maximized
  hide_apps?: { exe: string; name: string }[]; // hidden while one of these is in front
};
export const EMPTY_SETTINGS: Settings = { calendar_url: "", lyrics: false, off: [], ui: null };

/** Saved preferences on top of the defaults, dropping shortcuts that no longer exist. */
export function prefsOf(s: Settings): Prefs {
  const ui = s.ui ?? {};
  const pick = (l: string[] | undefined, d: string[]) =>
    Array.isArray(l) ? [...new Set(l)].filter((t) => t in SHORTCUTS).slice(0, MAX_SHORTCUTS) : d;
  return {
    openOn: ui.openOn === "hover" ? "hover" : "click",
    move: MOVES.find(([id]) => id === ui.move)?.[0] ?? "slide",
    material: MATERIALS.find(([id]) => id === ui.material)?.[0] ?? "black",
    accent: ACCENTS.find(([id]) => id === ui.accent)?.[0] ?? "white",
    showTime: ui.showTime !== false,
    showDot: ui.showDot !== false,
    idleTuck: ui.idleTuck === true,
    left: pick(ui.left, DEFAULT_PREFS.left),
    right: pick(ui.right, DEFAULT_PREFS.right),
    // Saved order first, then any tab added since.
    tabs: [...new Set([...(Array.isArray(ui.tabs) ? ui.tabs : []), ...TABS])].filter((t) => TABS.includes(t)),
    pomodoro: { ...POMODORO, ...ui.pomodoro },
  };
}
