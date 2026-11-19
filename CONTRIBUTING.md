# Contributing to Pulo

Thanks for helping. Pulo is a small project, so keep changes small too.

## Before you start

- **Bugs:** open an issue with your Windows version, steps to reproduce, and what you expected. A screenshot or screen recording helps a lot.
- **Features:** open an issue first so we can agree on the idea before you write code.
- **Small fixes** (typos, obvious bugs) can go straight to a pull request.

## Setup

You need Node.js 22+, Rust (stable) and the [Tauri prerequisites for Windows](https://tauri.app/start/prerequisites/).

```sh
npm install
npm start
```

`npm start` runs the island with hot reload for the React side. Changes to Rust code rebuild and restart it.

## Project layout

```
src/                 React UI (one webview per window)
  App.tsx            the island: pill, tabs (Now, Focus, Recent), music page
  extras.tsx         equalizer, lyrics panel, position bar, pet
  Settings.tsx       settings window
  Scratchpad.tsx     scratchpad window
  island.css         island styles
  ics.ts, lyrics.ts, pomodoro.ts    pure logic, checked by scripts/*.check.ts
  prefs.ts           feature list, shortcuts, defaults
src-pulo/src/        Rust (Tauri backend)
  lib.rs             windows, placement, commands, settings, startup
  sys.rs             media session, volume, downloads, notifications, calendar, lyrics fetch
  tools.rs           quick tools, speaker/mic volume, system stats, hotkey
  eq.rs              audio capture for the equalizer
  devices.rs         Bluetooth battery levels
  agents.rs          Claude Code session tracker
  update.rs          auto-updates
scripts/             unit checks and the MSIX packaging script
packaging/           MSIX manifest
```

Most Windows integration goes through the [`windows`](https://crates.io/crates/windows) crate (WinRT and Win32). The UI calls Rust with `invoke(...)`, and Rust pushes updates to the UI as events.

## Guidelines

- **Performance matters.** The island is always on screen. Avoid CSS animations that loop (`animation: … infinite`): in this window each one costs about 30% of a CPU core. Prefer one transition per state change, or update the DOM from JavaScript only while something is visible.
- **Prefer events over polling** for anything Windows can notify about.
- **Every feature can be turned off.** Add new features to `FEATURES` in `src/prefs.ts`. If a feature starts a background thread, start it from `start_watchers` in `lib.rs`.
- **Nothing leaves the PC without saying so.** Any new network request needs a line in Settings and in the README's Privacy section.
- **Accessibility:** buttons need labels, controls must work from the keyboard, and motion must respect `prefers-reduced-motion`.
- Keep dependencies to a minimum and the code plain. Comments say *why*, not what.

## Checks

Run these before opening a pull request:

```sh
npm run build                                      # TypeScript type-check and bundle
npm run check                                      # logic checks
cargo test --manifest-path src-pulo/Cargo.toml     # Rust tests
```

For UI changes, include before and after screenshots in the pull request.

## Testing notifications (MSIX dev build)

Windows only shows notifications to packaged apps, so testing that feature needs the MSIX build. You'll also need the Windows 11 SDK.

```powershell
npm run exe
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\msix.ps1 -Install
```

The first run creates a self-signed "CN=Pulo Dev" certificate and trusts it, which takes one admin prompt. `-Install` replaces the installed dev package and starts it. Close any running `pulo.exe` before `npm run exe`.

## Releases (maintainers)

1. Bump `version` in `package.json`, `src-pulo/tauri.conf.json` and `src-pulo/Cargo.toml`.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **Release** workflow builds a signed installer and creates a draft GitHub release.
4. Publish the draft. Installed copies update after that.

## Code of conduct

Be kind and assume good faith. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

By contributing, you agree that your work is released under the [MIT License](LICENSE).
