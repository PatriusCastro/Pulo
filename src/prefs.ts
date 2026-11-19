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
  ["tools", "Quick tools", "Dark mode, mic mute, keep awake, lock, Recycle Bin"],
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
};
/** Buttons that fit in one side column. Also MAX_SHORTCUTS in lib.rs. */
export const MAX_SHORTCUTS = 5;

export type Prefs = {
  openOn: "click" | "hover"; // click: hovering only peeks; hover: hovering opens it fully
  left: string[];
  right: string[];
  pomodoro: Config;
};

export const DEFAULT_PREFS: Prefs = {
  openOn: "click",
  left: ["settings", "mixer", "task_manager"],
  right: ["calculator", "screenshot", "explorer", "clipboard"],
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
    pomodoro: { ...POMODORO, ...ui.pomodoro },
  };
}
