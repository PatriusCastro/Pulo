mod sys;

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
        Foundation::HWND,
        Graphics::Gdi::{CreateRectRgn, SetWindowRgn},
        System::Registry::*,
        UI::{Shell::*, WindowsAndMessaging::*},
    },
};

const TOP_MARGIN: f64 = 6.0;
// The window is always the largest pill size and never resizes (resizing makes the web
// content jump for a frame). Instead its window region, which is the only part that is
// drawn and clickable, is set to the pill's current size. Clicks elsewhere pass through.
const MAX: (f64, f64) = (420.0, 236.0); // must match .pill.open in island.css
static REGION: Mutex<(f64, f64)> = Mutex::new((200.0, 36.0));

fn hwnd(w: &WebviewWindow) -> HWND {
    HWND(w.hwnd().expect("hwnd").0)
}

fn px(v: f64, s: f64) -> i32 {
    (v * s).round() as i32
}

/// Clip the window to the pill's current size, centered horizontally, flush to the top.
fn apply_region(w: &WebviewWindow) {
    let s = w.scale_factor().unwrap_or(1.0);
    let (rw, rh) = *REGION.lock().unwrap();
    let x0 = (px(MAX.0, s) - px(rw, s)) / 2;
    unsafe {
        let rgn = CreateRectRgn(x0, 0, x0 + px(rw, s), px(rh, s));
        SetWindowRgn(hwnd(w), Some(rgn), true); // the window takes ownership of rgn
    }
}

/// Size and center the window on the primary monitor.
fn place(w: &WebviewWindow) {
    let Ok(Some(m)) = w.primary_monitor() else { return };
    let s = m.scale_factor();
    let (pw, ph) = (px(MAX.0, s), px(MAX.1, s));
    let x = m.position().x + (m.size().width as i32 - pw) / 2;
    let y = m.position().y + px(TOP_MARGIN, s);
    unsafe {
        let _ = SetWindowPos(hwnd(w), Some(HWND_TOPMOST), x, y, pw, ph, SWP_NOACTIVATE);
    }
    apply_region(w);
}

#[tauri::command]
fn resize(window: WebviewWindow, w: f64, h: f64) {
    *REGION.lock().unwrap() = (w, h);
    apply_region(&window);
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
async fn media(action: String) {
    sys::media_control(&action);
}

// Sync on purpose: runs on the UI thread, which OLE drag and drop requires.
#[tauri::command]
fn drag_out(window: WebviewWindow, paths: Vec<String>) {
    let _ = sys::drag_files(hwnd(&window), &paths);
}

#[tauri::command]
async fn open_path(path: String) {
    sys::open_path(&path);
}

// ---------- settings (settings.json in the app config folder) ----------

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    #[serde(default)]
    calendar_url: String,
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
    let path = settings_file(&app);
    let mut s = load_settings(&app);
    s.calendar_url = url.trim().to_string();
    fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;
    fs::write(&path, serde_json::to_vec_pretty(&s).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(text)
}

#[tauri::command]
fn calendar() -> String {
    sys::CALENDAR.lock().unwrap().clone()
}

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    // Built off the event-loop thread: creating a webview inside a menu callback can deadlock.
    let app = app.clone();
    thread::spawn(move || {
        let _ = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("index.html#settings".into()))
            .title("Pulo settings")
            .inner_size(480.0, 380.0)
            .resizable(false)
            .center()
            .build();
    });
}

// ---------- autostart (HKCU Run key) ----------

const RUN_KEY: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Run");

#[tauri::command]
fn autostart_enabled() -> bool {
    unsafe { RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Pulo"), RRF_RT_REG_SZ, None, None, None).is_ok() }
}

#[tauri::command]
fn set_autostart(on: bool) {
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

/// True when a fullscreen app, game or presentation owns the foreground.
fn fullscreen_app_active() -> bool {
    matches!(
        unsafe { SHQueryUserNotificationState() },
        Ok(QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            resize,
            snapshot,
            media_art,
            media,
            drag_out,
            open_path,
            get_settings,
            set_calendar,
            calendar,
            autostart_enabled,
            set_autostart
        ])
        .setup(|app| {
            let _ = sys::APP.set(app.handle().clone());
            let w = app.get_webview_window("main").expect("main window");
            // Tool window: out of Alt+Tab and the taskbar.
            unsafe {
                let h = hwnd(&w);
                let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
                SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW.0 as isize);
            }
            place(&w);

            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Pulo", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("icon").clone())
                .tooltip("Pulo")
                .menu(&menu)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "settings" => open_settings(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            sys::watch_power();
            thread::spawn(|| sys::watch_downloads());

            // Calendar refresh every 10 minutes.
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                let url = load_settings(&handle).calendar_url;
                if !url.is_empty() {
                    let _ = sys::fetch_calendar(&url);
                }
                thread::sleep(Duration::from_secs(600));
            });

            // ponytail: 1 Hz poll for fullscreen, monitor changes and media (~0% CPU). Switch to
            // ABN_FULLSCREENAPP / WM_DISPLAYCHANGE / SMTC events if this ever shows up in a profile.
            // Also hides on any fullscreen app, even one on a different monitor.
            thread::spawn(move || {
                let _ = sys::watch_volume(); // inits COM on this long-lived thread
                let mut hidden = true; // window starts hidden; first tick shows it
                let mut last_geo = None;
                loop {
                    let fs = fullscreen_app_active();
                    if fs != hidden {
                        hidden = fs;
                        let cmd = if fs { SW_HIDE } else { SW_SHOWNOACTIVATE };
                        unsafe {
                            let _ = ShowWindow(hwnd(&w), cmd);
                        }
                    }
                    let geo = w.primary_monitor().ok().flatten().map(|m| {
                        (m.position().x, m.position().y, m.size().width, m.size().height, m.scale_factor().to_bits())
                    });
                    if geo != last_geo {
                        last_geo = geo;
                        place(&w); // monitor plugged/unplugged, resolution or DPI change
                    }
                    sys::poll_media();
                    thread::sleep(Duration::from_secs(1));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pulo");
}
