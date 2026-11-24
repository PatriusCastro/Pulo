// Settings shared by the island and the Settings window. Saved by Rust in settings.json:
// `off` and `lyrics` are enforced there, `ui` is ours alone.
import { DEFAULTS as POMODORO, type Config } from "./pomodoro";

/** Features that can be turned off, in the order Settings lists them. */
export const FEATURES = [
  ["media", "Now playing", "Track, album art and controls"],
  ["equalizer", "Live equalizer", "Bars that follow the music while the island is open"],
  ["notifications", "Notifications", "New Windows notifications appear in the island (MSIX build only)"],
  ["downloads", "Downloads", "Finished downloads appear and go to Recent"],
  ["calendar", "Calendar", "Next event, and a heads-up 15 minutes before"],
  ["agents", "AI agents", "Claude Code sessions, and a notice when a long task finishes"],
  ["devices", "Device batteries", "Bluetooth mouse, keyboard and headphones"],
  ["focus", "Focus timer", "Pomodoro rounds and quick timers"],
  ["todo", "To Do", "A checklist tab in the island"],
  ["tools", "Quick tools", "Wi-Fi, Bluetooth, dark mode, mic mute, keep awake, camera, color picker, lock, Recycle Bin"],
  ["hotkey", "Keyboard shortcut", "Ctrl+Alt+Space opens and closes the island"],
  ["pet", "Pet", "The little sprout in the pill"],
] as const;
export type Feature = (typeof FEATURES)[number][0];

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

export type Prefs = {
  openOn: "click" | "hover"; // click: hovering only peeks; hover: hovering opens it fully
  left: string[];
  right: string[];
  tabs: Tab[];
  pomodoro: Config;
};

export const DEFAULT_PREFS: Prefs = {
  openOn: "click",
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
    left: pick(ui.left, DEFAULT_PREFS.left),
    right: pick(ui.right, DEFAULT_PREFS.right),
    // Saved order first, then any tab added since.
    tabs: [...new Set([...(Array.isArray(ui.tabs) ? ui.tabs : []), ...TABS])].filter((t) => TABS.includes(t)),
    pomodoro: { ...POMODORO, ...ui.pomodoro },
  };
}
