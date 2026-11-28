// What's new, shown once in the island after Pulo updates (App.tsx). Newest first: add an
// entry with every release, under the version in tauri.conf.json.

export const NOTES: [version: string, items: string[]][] = [
  [
    "0.1.8",
    [
      "Update now: install an update from the island, then see what's new",
      "Appearance: Black, Glass or Frosted, a white or green accent, and a live preview",
      "Now: Bluetooth, dark mode, mic and keep awake a tap away",
      "Focus: edit the Pomodoro and timer lengths right in the tab",
      "A light while an app uses your camera or mic",
      "Peek shows what matters now: a meeting about to start, an agent at work, a call",
      "The island follows your mouse to another screen, with a Slide, Fade or Pop animation",
      "Codex sessions in the Agents tab, and an option to tuck away when idle",
      "Hides over YouTube and other full-screen browser videos",
    ],
  ],
  [
    "0.1.7",
    [
      "Focus tab: switch between Pomodoro, a stopwatch and a timer",
      "Timer: set any length from 1 minute to 3 hours, pause it, and it survives a restart",
      "Notifications: the island widens so the whole title fits (Microsoft Store version)",
    ],
  ],
  [
    "0.1.6",
    [
      "Performance page: CPU, memory, GPU and network with live graphs, and the apps using the most",
      "Display: brightness for each screen, and night light",
      "Wi-Fi & Bluetooth: switch them on and off, see your network and connected devices",
      "Power: power mode, a sleep or shut down timer, screen off, sleep, restart and shut down",
      "Color picker: pick any color on screen, copied as hex",
      "Camera mirror: check how you look before a call",
      "Volume mixer: choose which speakers or headphones play",
      "Tools tab: Wi-Fi, Bluetooth, camera, color picker, Display and Power tiles",
      "Settings > About: check for updates",
    ],
  ],
];

/** "0.1.10" > "0.1.9". Missing parts count as 0. */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** Notes for versions after `seen` up to `current`, newest first. */
export const notesSince = (seen: string, current: string) => NOTES.filter(([v]) => newer(v, seen) && !newer(v, current));
