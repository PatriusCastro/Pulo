mod agents;
mod clip;
mod shots;
mod devices;
mod eq;
mod hw;
mod picker;
mod sys;
mod tools;
mod update;

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex, thread, time::Duration};
use tauri::{
    ipc::Response,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{HWND, RECT},
        Graphics::Gdi::{CreateRectRgn, SetWindowRgn},
        System::Registry::*,
        UI::{Shell::*, WindowsAndMessaging::*},
    },
};

/// Gap between the top of the screen and the pill, in px; a setting (top_gap), 6 by default.
static TOP_GAP: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(6);
/// Transparent margin around the pill inside the window, for its smooth edge (see
/// apply_region). The pill's `top` in island.css.
const EDGE: f64 = 2.0;
// The window is always the largest pill size and never resizes (resizing makes the web
// content jump for a frame). Instead its window region, which is the only part that is
// drawn and clickable, is set to the pill's current size. Clicks elsewhere pass through.
// The open pill (420 wide, .pill.open in island.css) plus a 48 px shortcut column on
// each side (.side), and EDGE above and below it. Must match EXPANDED in App.tsx.
/// Window size. 40 px more than the open pill: hiding until the mouse comes near keeps the
/// window on the screen's edge and drops the island by the gap (up to 40) inside it.
const MAX: (f64, f64) = (516.0, 268.0 + 2.0 * EDGE + 40.0);
/// Shortcut buttons that fit in a side column (also MAX_SHORTCUTS in prefs.ts).
const MAX_SHORTCUTS: u32 = 5;
/// The notch style (a setting): flush with the top of the screen, with an inward curve this
/// wide on each side where it meets the edge (.ears in island.css).
static NOTCH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const EAR: f64 = 8.0;
/// Over a fullscreen video or browser, or always with auto-hide (a setting), the resting
/// island tucks up into the top edge, leaving TUCK_SHOW of the pill showing. The mouse
/// coming within NEAR of it brings it back down.
static TUCKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static AUTO_HIDE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const TUCK_SHOW: f64 = 4.0;
const NEAR: f64 = 12.0;

/// Untouched for a while with "Tuck away when idle" on: set by the island (set_idle).
static IDLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn tucked() -> bool {
    use std::sync::atomic::Ordering::Relaxed;
    TUCKED.load(Relaxed) || AUTO_HIDE.load(Relaxed) || IDLE.load(Relaxed)
}

#[tauri::command]
fn set_idle(window: WebviewWindow, idle: bool) {
    if IDLE.swap(idle, std::sync::atomic::Ordering::Relaxed) != idle {
        place(&window);
        apply_region(&window, window.scale_factor().unwrap_or(1.0));
    }
}

/// What's drawn and clickable: the pill at its current size, plus the shortcut buttons
/// beside it (counts are 0 unless the island is open).
#[derive(Clone, Copy)]
struct Region {
    w: f64,
    h: f64,
    left: u32,
    right: u32,
    out: bool, // tucked, but out of the edge because the mouse came near
}
static REGION: Mutex<Region> = Mutex::new(Region { w: 200.0, h: 36.0, left: 0, right: 0, out: false });

/// Long-lived background thread with a name (shows up in profilers and debuggers).
/// How long the pill takes to slide out of sight before moving screens (.moving in island.css).
const MOVE_OUT_MS: u64 = 100;
/// Set while it slides out, so the tick doesn't move the window mid-slide.
static MOVING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn named(name: &str, f: impl FnOnce() + Send + 'static) {
    let _ = thread::Builder::new().name(name.into()).spawn(f);
}

fn hwnd(w: &WebviewWindow) -> HWND {
    // Each lookup is a blocking round trip to the main thread, and the background loops ask
    // many times a second. The island's handle never changes, so look it up once. (Settings
    // and the scratchpad get a new one each time they open, so theirs aren't kept.)
    static ISLAND: std::sync::OnceLock<isize> = std::sync::OnceLock::new();
    if w.label() == "main" {
        return HWND(*ISLAND.get_or_init(|| w.hwnd().expect("hwnd").0 as isize) as _);
    }
    HWND(w.hwnd().expect("hwnd").0)
}

fn px(v: f64, s: f64) -> i32 {
    (v * s).round() as i32
}

/// The closed pill (COLLAPSED and BUBBLE in App.tsx), not peeking or open.
fn resting(r: Region) -> bool {
    r.h <= 36.0 && r.w <= 200.0
}

/// How far the window reaches above the top of the screen, in px: the notch and a tucked
/// island sit flush with the edge. (A tucked one slides up at rest in CSS, .tucked.)
fn lift(s: f64) -> Option<i32> {
    (tucked() || NOTCH.load(std::sync::atomic::Ordering::Relaxed)).then(|| px(EDGE, s))
}

/// Clip the window to the pill's shape: rounded like the pill (radius as in island.css),
/// centered, flush to the top, plus a circle per shortcut button (.side, .shortcut in
/// island.css). Outside this shape the window doesn't exist, so clicks pass through, and
/// if Windows ever drops the transparency there are no square corners left to turn white.
fn apply_region(w: &WebviewWindow, s: f64) {
    use windows::Win32::Graphics::Gdi::{CombineRgn, CreateEllipticRgn, CreateRoundRectRgn, DeleteObject, OffsetRgn, RGN_OR};
    let r = *REGION.lock().unwrap();
    let pill_w = r.w.min(MAX.0);
    let radius = if r.h <= 36.0 { r.h / 2.0 } else { 30.0 };
    let x0 = (px(MAX.0, s) - px(pill_w, s)) / 2;
    // Regions are whole pixels with no anti-aliasing. Cut exactly on the pill's edge, they
    // chop off the webview's smooth edge and leave stairs, so leave a little transparent
    // margin around every shape for that edge to fade out in. The pill sits EDGE below the
    // window's top so the margin goes all the way round.
    let m = px(EDGE, s);
    let lift = lift(s);
    let tuck = tucked() && resting(r) && !r.out;
    let notch = NOTCH.load(std::sync::atomic::Ordering::Relaxed);
    unsafe {
        // +1: GDI leaves out the right and bottom edges of round regions.
        let d = px(radius * 2.0, s) + 2 * m;
        // The notch's top corners are square: start the rounded shape above the window.
        let top = if notch { -d } else { 0 };
        let rgn = CreateRoundRectRgn(x0 - m, top, x0 + px(pill_w, s) + m + 1, px(r.h, s) + 2 * m + 1, d, d);
        if notch {
            let e = px(EAR, s);
            let ears = CreateRectRgn(x0 - m - e, m, x0 + px(pill_w, s) + m + e, m + e);
            CombineRgn(Some(rgn), Some(rgn), Some(ears), RGN_OR);
            let _ = DeleteObject(ears.into());
        }
        // 40 px buttons, 4 px into each 48 px column, rows every 48 px from 6 px below the
        // pill's top.
        for (n, x) in [(r.left, 4.0), (r.right, MAX.0 - 44.0)] {
            for row in 0..n.min(MAX_SHORTCUTS) {
                let y = EDGE + 6.0 + row as f64 * 48.0;
                let b = CreateEllipticRgn(px(x, s) - m, px(y, s) - m, px(x + 40.0, s) + m + 1, px(y + 40.0, s) + m + 1);
                CombineRgn(Some(rgn), Some(rgn), Some(b), RGN_OR);
                let _ = DeleteObject(b.into());
            }
        }
        // Lifted to hide (not the notch) and out: the island comes down to the gap, as the pill
        // does in CSS (--drop), with a strip above it so it's seen sliding down from the edge.
        if let (Some(l), false, false) = (lift, notch, tuck) {
            let g = px(TOP_GAP.load(std::sync::atomic::Ordering::Relaxed) as f64, s);
            let _ = OffsetRgn(rgn, 0, g);
            let strip = CreateRectRgn(x0 - m, l, x0 + px(pill_w, s) + m + 1, l + g + m);
            CombineRgn(Some(rgn), Some(rgn), Some(strip), RGN_OR);
            let _ = DeleteObject(strip.into());
        }
        // Tucked: the sliver of pill left showing, and an invisible band round it so the
        // mouse only has to come near.
        let n = px(NEAR.max(TUCK_SHOW), s);
        if let (Some(l), true) = (lift, tuck) {
            let band = CreateRectRgn(x0 - n, l, x0 + px(pill_w, s) + n, l + n);
            CombineRgn(Some(rgn), Some(rgn), Some(band), RGN_OR);
            let _ = DeleteObject(band.into());
        }
        // Nothing above the top of the screen: a screen stacked above this one would show it.
        // Tucked, nothing below the band either.
        if let Some(l) = lift {
            let bottom = if tuck { l + n } else { px(MAX.1, s) + 1 };
            let below = CreateRectRgn(0, l, px(MAX.0, s) + 1, bottom);
            CombineRgn(Some(rgn), Some(rgn), Some(below), windows::Win32::Graphics::Gdi::RGN_AND);
            let _ = DeleteObject(below.into());
        }
        keep_transparent(w); // before the redraw, so it never shows a frame without it
        SetWindowRgn(hwnd(w), Some(rgn), true); // the window takes ownership of rgn
    }
}

/// Transparency comes from DWM blur-behind with an empty region (how tao sets it up). tao
/// never re-applies it, and window activation or display changes can drop it, which turns
/// the pill's transparent corners white. Cheap and idempotent, so re-apply freely.
fn keep_transparent(w: &WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND};
    use windows::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH};
    unsafe {
        // The white is the window's own surface, which nothing paints. Paint it black: with
        // blur-behind on, black is see-through, and in the moments it's off, black blends into
        // the pill instead of flashing white. (Class-wide, so the Settings window gets it too;
        // its page covers it.)
        let _ = SetClassLongPtrW(hwnd(w), GCLP_HBRBACKGROUND, GetStockObject(BLACK_BRUSH).0 as isize);
        let empty = CreateRectRgn(0, 0, -1, -1);
        // Windows 11 draws a thin light border round windows, brighter once Pulo is the active
        // app (a click, the tray menu, Settings): the white arcs at the pill's ends. No border,
        // and none of its own corner rounding either.
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND};
        let none: u32 = 0xFFFF_FFFE; // DWMWA_COLOR_NONE
        let _ = DwmSetWindowAttribute(hwnd(w), DWMWA_BORDER_COLOR, &none as *const _ as _, 4);
        let _ = DwmSetWindowAttribute(hwnd(w), DWMWA_WINDOW_CORNER_PREFERENCE, &DWMWCP_DONOTROUND as *const _ as _, 4);
        let bb = DWM_BLURBEHIND { dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION, fEnable: true.into(), hRgnBlur: empty, fTransitionOnMaximized: false.into() };
        let _ = DwmEnableBlurBehindWindow(hwnd(w), &bb);
        let _ = windows::Win32::Graphics::Gdi::DeleteObject(empty.into());
    }
}

/// The screen the mouse is on, and the one the island is on (as handles to compare).
fn cursor_monitor() -> isize {
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};
    let mut c = Default::default();
    unsafe {
        let _ = GetCursorPos(&mut c);
        MonitorFromPoint(c, MONITOR_DEFAULTTOPRIMARY).0 as isize
    }
}
fn window_monitor(w: &WebviewWindow) -> isize {
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTOPRIMARY};
    unsafe { MonitorFromWindow(hwnd(w), MONITOR_DEFAULTTOPRIMARY).0 as isize }
}

/// Where the island belongs: top center of the screen the mouse is on, sized for that
/// screen's DPI. Returns the window rect (x, y, w, h) and the scale.
fn target() -> (RECT, f64) {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint};
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    unsafe {
        let mut c = Default::default();
        let _ = GetCursorPos(&mut c);
        let m = MonitorFromPoint(c, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(m, &mut info);
        let (mut dx, mut dy) = (96, 96);
        let _ = GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        let s = dx as f64 / 96.0;
        let r = info.rcMonitor;
        let (pw, ph) = (px(MAX.0, s), px(MAX.1, s));
        let x = r.left + (r.right - r.left - pw) / 2;
        let gap = TOP_GAP.load(std::sync::atomic::Ordering::Relaxed) as f64;
        let y = match lift(s) {
            Some(l) => r.top - l,
            None => r.top + px(gap - EDGE, s), // the pill sits EDGE into its window
        };
        (RECT { left: x, top: y, right: x + pw, bottom: y + ph }, s)
    }
}

/// Move the window where it belongs, unless it's already there. Called every second, so
/// the island follows the mouse between screens and survives monitor and DPI changes
/// (moving to a screen with another DPI makes Windows rescale the window afterwards; the
/// next call puts it right).
fn place(w: &WebviewWindow) {
    let (t, s) = target();
    let mut cur = RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd(w), &mut cur);
        if cur == t {
            return;
        }
        // Landing on a screen with another DPI makes tao rescale the window by the DPI ratio
        // on top of our size (WM_DPICHANGED), so set it again once it has arrived.
        for _ in 0..2 {
            let _ = SetWindowPos(hwnd(w), Some(HWND_TOPMOST), t.left, t.top, t.right - t.left, t.bottom - t.top, SWP_NOACTIVATE);
            let _ = GetWindowRect(hwnd(w), &mut cur);
            if cur == t {
                break;
            }
        }
    }
    apply_region(w, s);
    keep_transparent(w);
}

/// Right-click on the island: the window settings at hand, as a menu at the cursor. Built
/// fresh each time so the checks show what's saved now.
#[tauri::command]
fn quick_menu(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    use tauri::menu::{CheckMenuItem, PredefinedMenuItem, Submenu};
    let build = || -> tauri::Result<()> {
        let s = load_settings(&app);
        let check = |id: &str, label: &str, on: bool| CheckMenuItem::with_id(&app, id, label, true, on, None::<&str>);
        let style = if s.style.is_empty() { "pill" } else { s.style.as_str() };
        let pill = check("q-style-pill", "Pill", style == "pill")?;
        let notch = check("q-style-notch", "Notch", style == "notch")?;
        let bubble = check("q-style-bubble", "Bubble", style == "bubble")?;
        let look = Submenu::with_items(&app, "Look", true, &[&pill, &notch, &bubble])?;
        // Hide: every way of keeping the island out of sight, in one place.
        let tuck = check("q-auto-hide", "Until the mouse comes near", s.auto_hide)?;
        let videos = check("q-hide-fullscreen", "Over full-screen videos", s.hide_fullscreen)?;
        let browsers = check("q-hide-browsers", "Over browsers", s.hide_browsers)?;
        let maximized = check("q-hide-maximized", "Over maximized windows", s.hide_maximized)?;
        // The app you were in when you right-clicked (the island never takes focus).
        let front = front_app()
            .filter(|(_, _, exe)| exe != "explorer" && !BROWSERS.contains(&exe.as_str()))
            .map(|(_, path, exe)| HiddenApp { name: tools::describe(&path).unwrap_or_else(|| exe.clone()), exe });
        *MENU_APP.lock().unwrap() = front.clone();
        let mut apps = Vec::new();
        if let Some(a) = &front {
            let on = s.hide_apps.iter().any(|x| x.exe == a.exe);
            apps.push(check("q-hide-app", &format!("Over {}", a.name), on)?);
        }
        // The others already on the list, ticked; picking one takes it off.
        for (i, a) in s.hide_apps.iter().enumerate() {
            if front.as_ref().is_none_or(|f| f.exe != a.exe) {
                apps.push(check(&format!("q-unhide-{i}"), &format!("Over {}", a.name), true)?);
            }
        }
        let snoozed = now_ms() < SNOOZE_UNTIL.load(std::sync::atomic::Ordering::Relaxed);
        let snooze = if snoozed {
            MenuItem::with_id(&app, "q-unsnooze", "Show again", true, None::<&str>)?
        } else {
            MenuItem::with_id(&app, "q-snooze", "For an hour (Ctrl+Alt+Space brings it back)", true, None::<&str>)?
        };
        let sep1 = PredefinedMenuItem::separator(&app)?;
        let sep2 = PredefinedMenuItem::separator(&app)?;
        let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![&tuck, &sep1, &videos, &browsers, &maximized];
        items.extend(apps.iter().map(|a| a as &dyn tauri::menu::IsMenuItem<tauri::Wry>));
        items.extend([&sep2 as &dyn tauri::menu::IsMenuItem<tauri::Wry>, &snooze]);
        let hide = Submenu::with_items(&app, "Hide", true, &items)?;
        let through = check("q-click-through", "Click through", s.click_through)?;
        let settings = MenuItem::with_id(&app, "q-settings", "Settings…", true, None::<&str>)?;
        let quit = MenuItem::with_id(&app, "q-quit", "Quit Pulo", true, None::<&str>)?;
        let line = PredefinedMenuItem::separator(&app)?;
        window.popup_menu(&Menu::with_items(&app, &[&look, &hide, &through, &line, &settings, &quit])?)
    };
    build().map_err(|e| e.to_string())
}

/// A quick menu item was picked (ids from quick_menu; the tray's own ids are ignored here).
fn quick_menu_clicked(app: &AppHandle, id: &str) {
    let mut s = load_settings(app);
    match id {
        "q-auto-hide" => s.auto_hide = !s.auto_hide,
        "q-hide-fullscreen" => s.hide_fullscreen = !s.hide_fullscreen,
        "q-hide-browsers" => s.hide_browsers = !s.hide_browsers,
        "q-hide-maximized" => s.hide_maximized = !s.hide_maximized,
        "q-hide-app" => {
            let Some(a) = MENU_APP.lock().unwrap().clone() else { return };
            let had = s.hide_apps.len();
            s.hide_apps.retain(|x| x.exe != a.exe);
            if s.hide_apps.len() == had {
                s.hide_apps.push(a);
            }
        }
        "q-snooze" | "q-unsnooze" => {
            let until = if id == "q-snooze" { now_ms() + 3_600_000 } else { 0 };
            SNOOZE_UNTIL.store(until, std::sync::atomic::Ordering::Relaxed);
            if let Some(w) = app.get_webview_window("main") {
                update_visibility(&w);
            }
            return;
        }
        "q-click-through" => s.click_through = !s.click_through,
        "q-settings" => return open_settings(app),
        "q-quit" => return app.exit(0),
        _ => {
            if let Some(st) = id.strip_prefix("q-style-") {
                s.style = st.into();
            } else if let Some(i) = id.strip_prefix("q-unhide-").and_then(|i| i.parse::<usize>().ok()) {
                if i < s.hide_apps.len() {
                    s.hide_apps.remove(i);
                }
            } else {
                return;
            }
        }
    }
    let _ = save_settings(app, &s);
}

/// The pill's size, and how many shortcut buttons show on each side (0 unless open).
#[tauri::command]
fn resize(window: WebviewWindow, w: f64, h: f64, left: u32, right: u32, out: bool) {
    *REGION.lock().unwrap() = Region { w, h, left, right, out };
    apply_region(&window, window.scale_factor().unwrap_or(1.0));
    keep_transparent(&window);
}

/// The app that had the keyboard before the island took it (to-do typing); 0 if none.
static TYPED_FROM: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// The island never takes focus, except while you type a to-do: `on` lets it, `off` hands
/// the keyboard back to the app you were in (unless you've since clicked somewhere else).
#[tauri::command]
fn island_keyboard(window: WebviewWindow, on: bool) {
    use std::sync::atomic::Ordering::Relaxed;
    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    // Only the no-activate bit, by hand. Not tao's set_focusable: that rewrites the whole
    // style later on its own thread (dropping tool-window and the transparency) and redraws
    // the frame, which is what made the island flash.
    unsafe {
        let h = hwnd(&window);
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
        let na = WS_EX_NOACTIVATE.0 as isize;
        if on {
            let fg = GetForegroundWindow();
            if fg != h {
                TYPED_FROM.store(fg.0 as isize, Relaxed);
            }
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex & !na);
            // Allowed: the click that asked for this was input to this app.
            let _ = SetForegroundWindow(h);
            let _ = SetFocus(Some(h)); // wry passes it on to the page
        } else {
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | na);
            let prev = TYPED_FROM.swap(0, Relaxed);
            if GetForegroundWindow() == h && prev != 0 {
                let _ = SetForegroundWindow(HWND(prev as _));
            }
        }
    }
    // Activating (and leaving) the window drops the transparency, partly after this returns.
    refresh_island(window.app_handle());
}

/// Island shortcuts. Fixed list: the webview can't ask Windows to run anything else.
#[tauri::command]
fn launch(app: AppHandle, target: String) {
    let cmd = match target.as_str() {
        "settings" => return open_settings(&app),
        "scratchpad" => return open_window(&app, "scratchpad", "Pulo scratchpad", (420.0, 480.0), true),
        "mixer" => return sys::open_mixer(),
        "clipboard" => return sys::open_clipboard(),
        "calculator" => "calc.exe",
        "screenshot" => "ms-screenclip:",
        "explorer" => "explorer.exe",
        "task_manager" => "taskmgr.exe",
        "clipboard_settings" => "ms-settings:clipboard",
        // "Open in Windows" buttons on the island's tool pages
        "display" => "ms-settings:display",
        "nightlight" => "ms-settings:nightlight",
        "network" => "ms-settings:network",
        "bluetooth" => "ms-settings:bluetooth",
        "power" => "ms-settings:powersleep",
        "energy_saver" => "ms-settings:batterysaver",
        "camera_privacy" => "ms-settings:privacy-webcam",
        "sound" => "ms-settings:sound",
        _ => return,
    };
    sys::open_path(cmd);
}

#[tauri::command]
fn devices() -> Vec<devices::Device> {
    devices::DEVICES.lock().unwrap().clone()
}

#[tauri::command]
fn open_mixer() {
    sys::open_mixer();
}

/// tao hides the title bar but keeps the caption style, and when Pulo's active state changes
/// (a click, Settings opening, the tray menu) Windows repaints that hidden frame: a white
/// blink along the top edge. lParam -1 on WM_NCACTIVATE tells it not to repaint the frame;
/// tao still sees the message.
unsafe extern "system" fn no_frame_paint(h: HWND, msg: u32, wp: windows::Win32::Foundation::WPARAM, lp: windows::Win32::Foundation::LPARAM, _id: usize, _data: usize) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::{Foundation::LPARAM, UI::Shell::DefSubclassProc};
    let lp = if msg == WM_NCACTIVATE { LPARAM(-1) } else { lp };
    unsafe { DefSubclassProc(h, msg, wp, lp) }
}

/// Put the island's transparency back and repaint, now and twice more shortly after: what
/// drops it (a tray menu opening, another Pulo window taking focus) can finish after the event
/// that tells us. From another thread on purpose: the tray menu blocks the main one.
fn refresh_island(app: &AppHandle) {
    use windows::Win32::Graphics::Gdi::{RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE};
    let Some(w) = app.get_webview_window("main") else { return };
    // The page's own background too, in case WebView2 put its default (white) back.
    let _ = w.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    thread::spawn(move || {
        for ms in [0, 100, 400] {
            thread::sleep(Duration::from_millis(ms));
            keep_transparent(&w);
            unsafe {
                let _ = RedrawWindow(Some(hwnd(&w)), None, None, RDW_ERASE | RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN);
            }
        }
    });
}

/// Called by the UI after every click: clicking inside the webview drops the transparency.
#[tauri::command]
fn refresh_transparency(window: WebviewWindow) {
    keep_transparent(&window);
}

#[tauri::command]
fn snapshot() -> sys::Snapshot {
    sys::STATE.lock().unwrap().clone()
}

#[tauri::command]
fn media_art() -> Response {
    Response::new(sys::ART.lock().unwrap().clone())
}

#[tauri::command]
async fn media(action: String, value: Option<i64>) {
    sys::media_control(&action, value.unwrap_or(0));
}

#[tauri::command]
async fn open_path(path: String) {
    sys::open_path(&path);
}

// ---------- settings (settings.json in the app config folder) ----------

#[derive(Serialize, Deserialize, Default, Clone)]
struct Settings {
    #[serde(default)]
    calendar_url: String,
    #[serde(default)]
    lyrics: bool, // opt-in: sends track title/artist/length to lrclib.net
    #[serde(default)]
    off: Vec<String>, // features turned off (FEATURES in prefs.ts); everything else is on
    #[serde(default)]
    ui: serde_json::Value, // island-only preferences (Prefs in prefs.ts); not read here
    #[serde(default)]
    click_through: bool, // at rest, clicks go to what's under the island (watch_click_through)
    #[serde(default)]
    show_in_screenshots: bool, // off: hidden from screenshots, recordings and screen sharing
    #[serde(default)]
    top_gap: Option<u32>, // px between the top of the screen and the pill; None = 6
    #[serde(default)]
    style: String, // "pill", "notch" or "bubble" (STYLES in prefs.ts); "" = pill
    #[serde(default)]
    auto_hide: bool, // tucked into the top edge until the mouse comes near (TUCKED)
    #[serde(default)]
    hide_fullscreen: bool, // hidden, not just tucked, over full-screen videos (HIDE_FULLSCREEN)
    #[serde(default)]
    hide_browsers: bool, // hidden while a browser is in front (hidden_by_rule)
    #[serde(default)]
    hide_maximized: bool, // hidden while the window in front is maximized on its screen
    #[serde(default)]
    hide_apps: Vec<HiddenApp>, // hidden while one of these is in front
}

// ---------- click-through and screenshots ----------

static CLICK_THROUGH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// How far click-through fades the island while the mouse is over it (alpha out of 255).
/// Glass and Frosted are see-through already: faded as far as black, they all but vanish.
static FADE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(51);

fn apply_window_settings(app: &AppHandle, s: &Settings) {
    CLICK_THROUGH.store(s.click_through, std::sync::atomic::Ordering::Relaxed);
    let clear = matches!(s.ui["material"].as_str(), Some("glass" | "frosted")); // Prefs in prefs.ts
    FADE.store(if clear { 140 } else { 51 }, std::sync::atomic::Ordering::Relaxed);
    TOP_GAP.store(s.top_gap.unwrap_or(6).min(40), std::sync::atomic::Ordering::Relaxed); // place() moves it
    NOTCH.store(s.style == "notch", std::sync::atomic::Ordering::Relaxed);
    AUTO_HIDE.store(s.auto_hide, std::sync::atomic::Ordering::Relaxed);
    HIDE_FULLSCREEN.store(s.hide_fullscreen, std::sync::atomic::Ordering::Relaxed);
    *RULES.lock().unwrap() = (s.hide_browsers, s.hide_maximized, s.hide_apps.iter().map(|a| a.exe.clone()).collect());
    if let Some(w) = app.get_webview_window("main") {
        update_visibility(&w); // a rule turned on for the app in front applies now
        // Both change where the island sits and its shape; move it now, not on the next tick.
        place(&w);
        apply_region(&w, w.scale_factor().unwrap_or(1.0));
        use windows::Win32::Graphics::Gdi::{RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE};
        let a = if s.show_in_screenshots { WDA_NONE } else { WDA_EXCLUDEFROMCAPTURE };
        let mut cur = Default::default();
        unsafe {
            // Changing the affinity rebuilds the window's surface without its transparency
            // (white island), so only touch it on a real change, then restore and repaint.
            if GetWindowDisplayAffinity(hwnd(&w), &mut cur).is_ok() && cur == a.0 {
                return;
            }
            let _ = SetWindowDisplayAffinity(hwnd(&w), a);
            keep_transparent(&w);
            let _ = RedrawWindow(Some(hwnd(&w)), None, None, RDW_ERASE | RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN);
        }
    }
}

/// Whether the mouse is over the pill itself (not the transparent rest of the window).
fn over_pill(w: &WebviewWindow, r: Region) -> bool {
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    let (mut c, mut win) = (Default::default(), RECT::default());
    // From Windows, not w.scale_factor(): that's a round trip to the main thread, 20 times a second.
    let s = unsafe { GetDpiForWindow(hwnd(w)) } as f64 / 96.0;
    unsafe {
        let _ = GetCursorPos(&mut c);
        let _ = GetWindowRect(hwnd(w), &mut win);
    }
    let x0 = win.left + (px(MAX.0, s) - px(r.w, s)) / 2;
    let y0 = win.top + px(EDGE, s);
    (x0..x0 + px(r.w, s)).contains(&c.x) && (y0..y0 + px(r.h, s)).contains(&c.y)
}

/// Click-through, only while clicks pass through. Through tao, not by setting the styles by
/// hand: tao rebuilds the window's styles from its own flags whenever one changes, which
/// stripped hand-set ones and left the rebuilt surface white.
fn set_through(w: &WebviewWindow, through: bool) {
    use windows::Win32::Graphics::Gdi::{RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE};
    let _ = w.set_ignore_cursor_events(through); // applied later, on tao's thread
    unsafe {
        let h = hwnd(w);
        keep_transparent(w);
        let _ = RedrawWindow(Some(h), None, None, RDW_ERASE | RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN);
    }
}

/// Click-through mode: at rest (or peeking) the island passes clicks to whatever is under
/// it, a browser's tabs say, and fades while the mouse is over it. Holding Ctrl makes it
/// take clicks again, and once open (Ctrl+click or the keyboard shortcut) it works as usual.
// ponytail: polls at 20 Hz while the mode is on; a low-level mouse hook if that ever shows up.
fn watch_click_through(w: WebviewWindow) {
    use tauri::Emitter;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    let mut through = false;
    loop {
        let on = CLICK_THROUGH.load(std::sync::atomic::Ordering::Relaxed);
        let r = *REGION.lock().unwrap();
        let key = |k: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY| unsafe { GetAsyncKeyState(k.0 as i32) } < 0;
        let over = on && over_pill(&w, r);
        // Not while tucked: the mouse coming near the sliver is what brings the island out.
        let t = on && r.h <= 36.0 && !key(VK_CONTROL) && !tucked();
        if t != through {
            set_through(&w, t);
            through = t;
            let _ = w.emit("passthrough", t); // no mouseleave arrives once clicks pass through
        }
        // The window's opacity: faded (FADE) while the mouse is over it, to see what's under it.
        // Faded here, not with CSS opacity in the page: that let whatever was behind the page
        // show through, white at times. Also, a layered window draws nothing (Pulo vanishes)
        // until it has an opacity, and tao makes it layered without one. So check every tick.
        unsafe {
            let h = hwnd(&w);
            let want = if t && over { FADE.load(std::sync::atomic::Ordering::Relaxed) } else { 255 };
            let mut alpha = 0u8;
            if GetWindowLongPtrW(h, GWL_EXSTYLE) & WS_EX_LAYERED.0 as isize != 0
                && (GetLayeredWindowAttributes(h, None, Some(&mut alpha), None).is_err() || alpha != want)
            {
                let _ = SetLayeredWindowAttributes(h, windows::Win32::Foundation::COLORREF(0), want, LWA_ALPHA);
            }
        }
        thread::sleep(Duration::from_millis(if on { 50 } else { 500 }));
    }
}

/// Features turned off, as last saved. Read by the background loops.
static OFF: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn on(feature: &str) -> bool {
    !OFF.lock().unwrap().iter().any(|f| f == feature)
}

/// Start the watcher thread of every feature that's on and not running yet. Turning a
/// feature off hides it at once; its thread stops with the next launch.
// ponytail: watchers block forever in OS waits, so there's no clean stop. Give each a stop
// flag if leaving one running until restart ever matters.
fn start_watchers() {
    static STARTED: Mutex<Vec<&str>> = Mutex::new(Vec::new());
    let watchers: [(&str, fn()); 6] = [
        ("media", sys::watch_media),
        ("downloads", || drop(sys::watch_downloads())),
        ("agents", || drop(agents::watch())),
        ("devices", devices::watch),
        ("equalizer", eq::run),
        ("hotkey", tools::watch_hotkey),
    ];
    let mut started = STARTED.lock().unwrap();
    for (name, f) in watchers {
        if on(name) && !started.contains(&name) {
            started.push(name);
            named(name, f);
        }
    }
}

/// Save, then tell every window (the island follows changes made in Settings at once).
fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let path = settings_file(app);
    fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;
    fs::write(&path, serde_json::to_vec_pretty(s).unwrap_or_default()).map_err(|e| e.to_string())?;
    *OFF.lock().unwrap() = s.off.clone();
    start_watchers();
    apply_window_settings(app, s);
    use tauri::Emitter;
    let _ = app.emit("settings", s.clone());
    Ok(())
}

#[tauri::command]
fn set_lyrics(app: AppHandle, on: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.lyrics = on;
    save_settings(&app, &s)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_window(
    app: AppHandle,
    click_through: Option<bool>,
    show_in_screenshots: Option<bool>,
    top_gap: Option<u32>,
    style: Option<String>,
    auto_hide: Option<bool>,
    hide_fullscreen: Option<bool>,
    hide_browsers: Option<bool>,
    hide_maximized: Option<bool>,
    hide_apps: Option<Vec<HiddenApp>>,
) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.hide_fullscreen = hide_fullscreen.unwrap_or(s.hide_fullscreen);
    s.hide_browsers = hide_browsers.unwrap_or(s.hide_browsers);
    s.hide_maximized = hide_maximized.unwrap_or(s.hide_maximized);
    if let Some(list) = hide_apps {
        s.hide_apps = list;
    }
    s.auto_hide = auto_hide.unwrap_or(s.auto_hide);
    if let Some(st) = style.filter(|st| ["pill", "notch", "bubble"].contains(&st.as_str())) {
        s.style = st;
    }
    s.top_gap = top_gap.or(s.top_gap);
    s.click_through = click_through.unwrap_or(s.click_through);
    s.show_in_screenshots = show_in_screenshots.unwrap_or(s.show_in_screenshots);
    save_settings(&app, &s)
}

/// Save the feature switches and/or the island preferences.
#[tauri::command]
fn set_prefs(app: AppHandle, off: Option<Vec<String>>, ui: Option<serde_json::Value>) -> Result<(), String> {
    let mut s = load_settings(&app);
    if let Some(off) = off {
        s.off = off;
    }
    if let Some(ui) = ui {
        s.ui = ui;
    }
    save_settings(&app, &s)
}

/// Synced lyrics for a track, or "" if none. Refuses unless the user opted in.
#[tauri::command]
async fn lyrics(app: AppHandle, artist: String, title: String, secs: i64) -> Result<String, String> {
    if !load_settings(&app).lyrics {
        return Err("Lyrics are turned off in Settings.".into());
    }
    sys::fetch_lyrics(&artist, &title, secs)
}

fn settings_file(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_default().join("settings.json")
}

fn load_settings(app: &AppHandle) -> Settings {
    fs::read(settings_file(app)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

/// Save the calendar link only if it loads, and return the calendar text.
#[tauri::command]
async fn set_calendar(app: AppHandle, url: String) -> Result<String, String> {
    let text = sys::fetch_calendar(&url)?;
    let mut s = load_settings(&app);
    s.calendar_url = url.trim().to_string();
    save_settings(&app, &s)?;
    Ok(text)
}

/// The UI turns the equalizer on while the expanded panel shows a playing track.
#[tauri::command]
fn equalizer(on: bool, fps: Option<u64>) {
    use std::sync::atomic::Ordering::Relaxed;
    if let Some(fps) = fps {
        eq::INTERVAL_MS.store(1000 / fps.clamp(1, 60), Relaxed);
    }
    eq::ON.store(on, Relaxed);
}

#[tauri::command]
fn agents() -> agents::Agents {
    agents::AGENTS.lock().unwrap().clone()
}

#[tauri::command]
fn calendar() -> String {
    sys::CALENDAR.lock().unwrap().clone()
}

fn open_settings(app: &AppHandle) {
    open_window(app, "settings", "Pulo settings", (920.0, 640.0), false);
}

/// Show the window `label` (index.html#label), creating it the first time.
fn open_window(app: &AppHandle, label: &'static str, title: &'static str, (w, h): (f64, f64), resizable: bool) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.unminimize();
        to_front(&win);
        return;
    }
    // Built off the event-loop thread: creating a webview inside a menu callback can deadlock.
    let app = app.clone();
    thread::spawn(move || {
        if let Ok(win) = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(format!("index.html#{label}").into()))
            .title(title)
            .inner_size(w, h)
            .resizable(resizable)
            .center()
            .build()
        {
            to_front(&win);
        }
    });
}

/// Windows only lets the app in front bring a window forward, and the island never takes
/// focus, so a window opened from it lands behind the others. On top for a moment lifts it
/// above them anyway; then it's an ordinary window again.
fn to_front(win: &WebviewWindow) {
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus();
    let _ = win.set_always_on_top(false);
}

// ---------- autostart (HKCU Run key) ----------

const RUN_KEY: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Run");

/// Installed as an MSIX (Store or local test package) rather than by the .exe installer.
fn packaged() -> bool {
    windows::ApplicationModel::Package::Current().is_ok()
}

/// Packaged apps can't use the Run key (their HKCU writes go to a private copy), so they
/// start with Windows through the manifest's startup task instead.
fn startup_task() -> Option<windows::ApplicationModel::StartupTask> {
    windows::ApplicationModel::StartupTask::GetAsync(windows::core::h!("Pulo")).ok()?.get().ok()
}

#[tauri::command(async)]
fn autostart_enabled() -> bool {
    if packaged() {
        use windows::ApplicationModel::StartupTaskState as S;
        return startup_task().is_some_and(|t| matches!(t.State(), Ok(S::Enabled | S::EnabledByPolicy)));
    }
    unsafe { RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Pulo"), RRF_RT_REG_SZ, None, None, None).is_ok() }
}

#[tauri::command(async)] // off the UI thread: the startup task calls block on WinRT
fn set_autostart(on: bool) {
    if packaged() {
        if let Some(t) = startup_task() {
            let _ = if on { t.RequestEnableAsync().and_then(|op| op.get()).map(|_| ()) } else { t.Disable() };
        }
        return;
    }
    unsafe {
        if on {
            let exe = std::env::current_exe().unwrap_or_default();
            let cmd: Vec<u16> = format!("\"{}\"", exe.display()).encode_utf16().chain([0]).collect();
            let _ = RegSetKeyValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Pulo"), REG_SZ.0, Some(cmd.as_ptr() as _), (cmd.len() * 2) as u32);
        } else {
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Pulo"));
        }
    }
}

/// A fullscreen app owns the foreground: (hide, tuck). Games and presentations hide the
/// island; any other fullscreen app (a video, a browser) tucks it into the top edge.
// ---------- hiding over apps (browsers, maximized windows, picked apps) ----------

/// An app the island hides over: its program's file name (lower case, no .exe) and the
/// name to show for it.
#[derive(Serialize, Deserialize, Default, Clone, PartialEq)]
struct HiddenApp {
    exe: String,
    name: String,
}

/// Program names of the common browsers.
const BROWSERS: [&str; 15] = [
    "chrome", "msedge", "firefox", "brave", "opera", "opera_gx", "vivaldi", "arc", "zen", "waterfox", "librewolf", "floorp", "thorium", "chromium", "iexplore",
];

/// Hide (not just tuck) over full-screen videos and other borderless full-screen apps.
static HIDE_FULLSCREEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The saved rules: over browsers, over maximized windows, over these apps.
static RULES: Mutex<(bool, bool, Vec<String>)> = Mutex::new((false, false, Vec::new()));
/// "For an hour" from the menu: hidden until then (ms since 1970). Not saved.
static SNOOZE_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// The shortcut brought it out while a rule had it hidden: it stays out until it closes.
static SHOWN_ANYWAY_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Whether the window is hidden now. It starts hidden; the first update shows it.
static HIDDEN: Mutex<bool> = Mutex::new(true);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The window in front and its program (path, and file name in lower case), unless it's Pulo's.
fn front_app() -> Option<(HWND, String, String)> {
    unsafe {
        let fg = GetForegroundWindow();
        let mut pid = 0;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid == 0 || pid == std::process::id() {
            return None;
        }
        let path = tools::exe_path(pid)?;
        let exe = std::path::Path::new(&path).file_stem()?.to_string_lossy().to_lowercase();
        Some((fg, path, exe))
    }
}

/// Whether a hide rule says the island shouldn't show right now.
/// busy: a full-screen video or app is in front (fullscreen_app).
fn hidden_by_rule(w: &WebviewWindow, busy: bool) -> bool {
    use std::sync::atomic::Ordering::Relaxed;
    let now = now_ms();
    let at = SHOWN_ANYWAY_AT.load(Relaxed);
    if at != 0 {
        // Out by the shortcut: a few seconds to get going, then for as long as it's open.
        if now.saturating_sub(at) < 3000 || REGION.lock().unwrap().h > 36.0 {
            return false;
        }
        SHOWN_ANYWAY_AT.store(0, Relaxed);
    }
    if now < SNOOZE_UNTIL.load(Relaxed) {
        return true;
    }
    // A slideshow is on an audience's screen: hidden whatever the settings (as Windows holds
    // back notifications then). Only the shortcut, above, brings it out.
    if matches!(unsafe { SHQueryUserNotificationState() }, Ok(QUNS_PRESENTATION_MODE)) {
        return true;
    }
    // Never out from under the mouse: a click through the island brings the app below it to
    // the front (often a maximized one), which would make it vanish as you click. The 1 s tick
    // applies the rule once the mouse moves away.
    if !*HIDDEN.lock().unwrap() && over_pill(w, *REGION.lock().unwrap()) {
        return false;
    }
    // Only with Hide over full-screen videos on; off, the island tucks into the top edge.
    if busy && HIDE_FULLSCREEN.load(Relaxed) {
        return true;
    }
    let (browsers, maximized, apps) = RULES.lock().unwrap().clone();
    if !browsers && !maximized && apps.is_empty() {
        return false;
    }
    let Some((fg, _, exe)) = front_app() else { return false };
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};
    (browsers && BROWSERS.contains(&exe.as_str()))
        || apps.contains(&exe)
        // Maximized on the screen the island is on, not just anywhere.
        || (maximized
            && unsafe { IsZoomed(fg).as_bool() && MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST) == MonitorFromWindow(hwnd(w), MONITOR_DEFAULTTONEAREST) })
}

/// Show or hide the island: hidden over fullscreen apps and wherever a hide rule says.
/// Called each second (tick) and the moment another window comes to the front.
fn update_visibility(w: &WebviewWindow) {
    let busy = fullscreen_app();
    let hide = hidden_by_rule(w, busy);
    let mut hidden = HIDDEN.lock().unwrap();
    if hide != *hidden {
        *hidden = hide;
        // Through tao, so it knows: shown behind its back, its next style rebuild hid the
        // island again. Not focusable, so showing doesn't activate it.
        let _ = if hide { w.hide() } else { w.show() };
    }
    drop(hidden); // never hold it into SetWindowPos: the main thread also takes it (set_prefs)
    // A full-screen app that is itself always-on-top (games, some players) lands above the
    // island when it comes to the front, so put the island back on top of the pile. Once per
    // app coming to the front, not every tick: fighting an exclusive-mode game for the top
    // each second can make it stutter or minimize.
    static LAST_FG: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
    let fg = unsafe { GetForegroundWindow() }.0 as isize;
    if !hide && busy && LAST_FG.swap(fg, std::sync::atomic::Ordering::Relaxed) != fg {
        unsafe {
            // Async: doesn't wait on the window's thread, which may be the caller's.
            let _ = SetWindowPos(hwnd(w), Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
        }
    } else if !busy {
        LAST_FG.store(0, std::sync::atomic::Ordering::Relaxed); // next full-screen app re-asserts
    }
}

/// Ctrl+Alt+Space: if a rule has the island hidden, bring it out (and end "for an hour").
pub(crate) fn shortcut_pressed() {
    use std::sync::atomic::Ordering::Relaxed;
    SNOOZE_UNTIL.store(0, Relaxed);
    SHOWN_ANYWAY_AT.store(now_ms(), Relaxed);
    if let Some(w) = sys::APP.get().and_then(|a| a.get_webview_window("main")) {
        update_visibility(&w);
    }
}

/// Re-check the moment another window comes to the front, so the island is already gone
/// when the browser shows (the 1 s tick would leave it on screen for a moment).
fn watch_foreground() {
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    unsafe extern "system" fn changed(_: HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
        if let Some(w) = sys::APP.get().and_then(|a| a.get_webview_window("main")) {
            update_visibility(&w);
        }
    }
    unsafe {
        let _ = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(changed), 0, 0, WINEVENT_OUTOFCONTEXT);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
    }
}

/// The app that was in front when the quick menu opened (exe, name): its "Over …" item.
static MENU_APP: Mutex<Option<HiddenApp>> = Mutex::new(None);

/// A full-screen app is running: a video, a game, a slideshow. The island tucks over it, or
/// hides when Hide over full-screen videos is on. (It used to hide over games whatever the
/// setting said.) Slideshows always hide it (update_visibility).
fn fullscreen_app() -> bool {
    matches!(
        unsafe { SHQueryUserNotificationState() },
        Ok(QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE | QUNS_BUSY)
    ) || covers_screen(unsafe { GetForegroundWindow() })
}

/// The window covers its whole screen, taskbar included: a browser's full-screen video
/// (YouTube's ⛶, F11), which Windows often doesn't report as full screen. Not a maximized
/// window (that leaves the taskbar, or is zoomed), nor the desktop, nor Pulo's own.
fn covers_screen(fg: HWND) -> bool {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL};
    unsafe {
        if fg.0.is_null() || IsZoomed(fg).as_bool() || !IsWindowVisible(fg).as_bool() {
            return false;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid == std::process::id() {
            return false;
        }
        let mut class = [0u16; 32];
        let n = GetClassNameW(fg, &mut class) as usize;
        if matches!(String::from_utf16_lossy(&class[..n]).as_str(), "Progman" | "WorkerW") {
            return false; // the desktop, which is screen-sized too
        }
        let m = MonitorFromWindow(fg, MONITOR_DEFAULTTONULL);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let mut r = RECT::default();
        if m.is_invalid() || !GetMonitorInfoW(m, &mut info).as_bool() || GetWindowRect(fg, &mut r).is_err() {
            return false;
        }
        let s = info.rcMonitor;
        r.left <= s.left && r.top <= s.top && r.right >= s.right && r.bottom >= s.bottom
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // One island only: a second copy would stack its window on top of this one.
    // The handle stays open for the life of the process.
    unsafe {
        use windows::Win32::{Foundation::*, System::Threading::CreateMutexW};
        let _ = CreateMutexW(None, true, windows::core::w!("Local\\Pulo.SingleInstance"));
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return;
        }
    }
    // Release builds abort on panic with no console, so leave a note of where it happened:
    // %LOCALAPPDATA%\com.pulo.dev\panic.log.
    std::panic::set_hook(Box::new(|info| {
        let dir = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("com.pulo.dev");
        let _ = fs::create_dir_all(&dir);
        let thread = thread::current().name().unwrap_or("?").to_string();
        let line = format!("{} [{thread}] {info}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
        use std::io::Write;
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("panic.log")) {
            let _ = f.write_all(line.as_bytes());
        }
    }));
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Focus moving between any of Pulo's windows (the island, Settings, the tray menu's
        // hidden window) drops the island's transparency: white behind the pill.
        .on_window_event(|win, e| {
            if let tauri::WindowEvent::Focused(_) = e {
                refresh_island(win.app_handle());
            }
        })
        .on_menu_event(|app, e| quick_menu_clicked(app, e.id.as_ref()))
        .invoke_handler(tauri::generate_handler![
            quick_menu,
            resize,
            refresh_transparency,
            open_mixer,
            devices,
            launch,
            snapshot,
            media_art,
            media,
            open_path,
            get_settings,
            set_calendar,
            calendar,
            agents,
            equalizer,
            set_lyrics,
            set_prefs,
            island_keyboard,
            lyrics,
            tools::tools_state,
            tools::tool,
            tools::stats,
            tools::volume,
            tools::set_volume,
            tools::set_muted,
            clip::clip_history,
            clip::clip_paste,
            clip::clip_delete,
            clip::clip_clear,
            clip::clip_copy,
            clip::clip_image,
            tools::app_volumes,
            tools::set_app_volume,
            set_idle,
            shots::screenshots,
            shots::screenshot_image,
            shots::open_screenshot,
            shots::screenshot_full,
            tools::hotkey_ok,
            update::update_status,
            update::update_click,
            tools::top_apps,
            hw::display,
            hw::set_brightness,
            hw::set_night_light,
            hw::radios,
            hw::set_radio,
            hw::power,
            hw::set_power_mode,
            hw::power_action,
            hw::set_power_timer,
            hw::outputs,
            hw::set_output,
            picker::pick_color,
            picker::colors,
            autostart_enabled,
            set_autostart,
            set_window
        ])
        .setup(|app| {
            let _ = sys::APP.set(app.handle().clone());
            // Built here rather than from the config (create: false there) so the island can
            // use the camera for Camera mirror without WebView2 prompting; nothing else is granted.
            let w = WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_permission_request(|_, kind| match kind {
                    tauri::webview::PermissionKind::Camera => tauri::webview::PermissionResponse::Allow,
                    _ => tauri::webview::PermissionResponse::Default,
                })
                .build()?;
            // Tool window: out of Alt+Tab and the taskbar. No-activate: clicking the island
            // never steals focus from the app you're in (and activation was what dropped the
            // window's transparency, see keep_transparent).
            unsafe {
                let h = hwnd(&w);
                let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
                SetWindowLongPtrW(h, GWL_EXSTYLE, ex | (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE).0 as isize);
            }
            // Also tell tao, or its next style rebuild drops no-activate (see set_through).
            let _ = w.set_focusable(false);
            unsafe {
                let _ = windows::Win32::UI::Shell::SetWindowSubclass(hwnd(&w), Some(no_frame_paint), 1, 0);
            }
            place(&w);
            apply_window_settings(app.handle(), &load_settings(app.handle()));
            let cw = w.clone();
            named("click-through", move || watch_click_through(cw));
            named("foreground", watch_foreground);

            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let updates = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Pulo", true, None::<&str>)?;
            // The Store updates packaged copies itself; only the .exe install updates from GitHub.
            let menu = if packaged() {
                Menu::with_items(app, &[&settings, &quit])?
            } else {
                update::start(app.handle().clone(), updates.clone());
                Menu::with_items(app, &[&settings, &updates, &quit])?
            };
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("icon").clone())
                .tooltip("Pulo")
                .menu(&menu)
                .on_tray_icon_event(|tray, _| refresh_island(tray.app_handle()))
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "settings" => open_settings(app),
                    "update" => update::clicked(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            sys::watch_power();
            sys::request_notification_access(); // UI thread: required for the consent prompt
            *OFF.lock().unwrap() = load_settings(app.handle()).off;
            start_watchers();

            // Calendar refresh every 10 minutes.
            let handle = app.handle().clone();
            named("calendar", move || loop {
                let url = load_settings(&handle).calendar_url;
                if !url.is_empty() && on("calendar") {
                    let _ = sys::fetch_calendar(&url);
                }
                thread::sleep(Duration::from_secs(600));
            });

            // ponytail: 1 Hz poll for fullscreen, monitor changes and notifications (~0% CPU).
            // Switch to ABN_FULLSCREENAPP / WM_DISPLAYCHANGE if this ever shows up in a profile.
            // Media is event-driven (sys::watch_media).
            // Also hides or tucks on any fullscreen app, even one on a different monitor.
            // Following the mouse to another screen can't wait for the tick: check the cursor's
            // screen 10 times a second (one cheap call) and move the moment it changes. The
            // pill slides up out of sight first, then down on the new screen (.moving, App.tsx).
            let fw = w.clone();
            named("follow", move || {
                use tauri::Emitter;
                let mut stuck = 0isize; // a screen it couldn't land on: don't replay the slide forever
                loop {
                    // Against the island's own screen, not the last one seen: if anything else
                    // moved it, there's nothing to animate.
                    let to = cursor_monitor();
                    if to != window_monitor(&fw) && to != stuck {
                        MOVING.store(true, std::sync::atomic::Ordering::Relaxed);
                        let _ = fw.emit("moving", true);
                        thread::sleep(Duration::from_millis(MOVE_OUT_MS));
                        place(&fw);
                        MOVING.store(false, std::sync::atomic::Ordering::Relaxed);
                        let _ = fw.emit("moving", false);
                        stuck = if window_monitor(&fw) == to { 0 } else { to };
                    } else if to == window_monitor(&fw) {
                        stuck = 0;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            });
            named("tick", move || {
                let _ = sys::watch_volume(); // inits COM on this long-lived thread
                let _ = tools::watch_mic();
                let mut away = false;
                let mut awake = false;
                let mut live: (Vec<String>, Vec<String>) = Default::default();
                loop {
                    let tuck = fullscreen_app();
                    if TUCKED.swap(tuck, std::sync::atomic::Ordering::Relaxed) != tuck {
                        use tauri::Emitter;
                        let _ = w.emit("tucked", tuck); // the pill slides up or down (.tucked)
                        place(&w);
                        apply_region(&w, w.scale_factor().unwrap_or(1.0));
                    }
                    update_visibility(&w); // fullscreen apps and the hide rules
                    // Monitor and DPI changes; no-op when already there. Going to another screen
                    // is the follow thread's, with its animation: not while one runs, nor when
                    // the mouse is on another screen than the island.
                    if !MOVING.load(std::sync::atomic::Ordering::Relaxed) && cursor_monitor() == window_monitor(&w) {
                        place(&w);
                    }
                    // Windows drops the transparency now and then (focus and display changes),
                    // which paints the margin around the pill white. Put it back within a second.
                    keep_transparent(&w);
                    // tao has no flag for tool window (out of Alt+Tab), so its style rebuilds
                    // drop the one set in setup. Put it back; it doesn't touch layered.
                    unsafe {
                        let ex = GetWindowLongPtrW(hwnd(&w), GWL_EXSTYLE);
                        if ex & WS_EX_TOOLWINDOW.0 as isize == 0 {
                            SetWindowLongPtrW(hwnd(&w), GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW.0 as isize);
                        }
                    }
                    if on("notifications") {
                        sys::poll_notifications();
                    }
                    // Camera and mic in use: the pill's live light.
                    let now = if on("tools") { tools::in_use() } else { Default::default() };
                    if now != live {
                        use tauri::Emitter;
                        let _ = w.emit("in_use", &now);
                        live = now;
                    }
                    // Keep awake is held by this thread: the request lasts while it's set here.
                    let want = tools::AWAKE.load(std::sync::atomic::Ordering::Relaxed);
                    if want != awake {
                        awake = want;
                        tools::hold_awake(want);
                    }
                    hw::tick_power_timer();
                    if sys::user_away() != away {
                        away = !away;
                        use tauri::Emitter;
                        let _ = w.emit("away", away); // the pet naps while you're away
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pulo");
}

#[cfg(test)]
mod hide_tests {
    #[test]
    fn no_window_is_not_full_screen() {
        assert!(!super::covers_screen(super::HWND(std::ptr::null_mut())));
    }

    /// Reads the app in front, as the hide rules and the quick menu see it. Run by hand:
    /// cargo test --lib front_app -- --ignored --nocapture
    #[test]
    #[ignore]
    fn front_app() {
        println!("front covers its screen: {}", super::covers_screen(unsafe { super::GetForegroundWindow() }));
        let (_, path, exe) = super::front_app().expect("an app in front");
        println!("front: {exe} ({}) browser: {}", super::tools::describe(&path).unwrap_or_default(), super::BROWSERS.contains(&exe.as_str()));
        assert!(!exe.is_empty() && !exe.ends_with(".exe"));
    }
}
