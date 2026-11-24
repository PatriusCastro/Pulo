//! Auto-update from GitHub Releases. Builds from the release workflow publish a signed
//! latest.json; Pulo checks it 30 s after start and then daily, and only installs when
//! the user picks the tray item.
use std::{
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Wry, async_runtime::block_on, menu::MenuItem};
use tauri_plugin_updater::{Update, UpdaterExt};

static ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();
static PENDING: Mutex<Option<Update>> = Mutex::new(None);

/// What the tray item says, and whether it can be clicked; Settings shows the same.
static STATUS: Mutex<Option<(String, bool)>> = Mutex::new(None);

fn label(text: &str, enabled: bool) {
    if let Some(i) = ITEM.get() {
        let _ = i.set_text(text);
        let _ = i.set_enabled(enabled);
    }
    *STATUS.lock().unwrap() = Some((text.to_string(), enabled));
    if let Some(app) = crate::sys::APP.get() {
        use tauri::Emitter;
        let _ = app.emit("update_status", (text, enabled));
    }
}

/// None: this copy updates through the Microsoft Store, not from GitHub.
#[tauri::command]
pub fn update_status() -> Option<(String, bool)> {
    ITEM.get()?;
    Some(STATUS.lock().unwrap().clone().unwrap_or(("Check for updates".into(), true)))
}

/// Settings' button: the same as clicking the tray item.
#[tauri::command]
pub fn update_click(app: AppHandle) {
    if ITEM.get().is_some() {
        clicked(&app);
    }
}

/// Ask GitHub for a newer version; the tray item says what was found.
async fn check(app: &AppHandle) -> bool {
    let found = match app.updater() {
        Ok(u) => u.check().await.ok().flatten(), // offline or no release yet: just no update
        Err(_) => None,
    };
    match &found {
        Some(u) => label(&format!("Install Pulo {}", u.version), true),
        None => label("Check for updates", true),
    }
    let any = found.is_some();
    *PENDING.lock().unwrap() = found;
    any
}

pub fn start(app: AppHandle, item: MenuItem<Wry>) {
    let _ = ITEM.set(item);
    let _ = thread::Builder::new().name("update".into()).spawn(move || {
        thread::sleep(Duration::from_secs(30)); // don't compete with startup
        loop {
            block_on(check(&app));
            thread::sleep(Duration::from_secs(24 * 3600));
        }
    });
}

/// Tray click: install the pending update, or check now if there isn't one.
pub fn clicked(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        block_on(async {
            let pending = PENDING.lock().unwrap().take();
            let Some(u) = pending else {
                label("Checking for updates…", false);
                if !check(&app).await {
                    label("Pulo is up to date", true);
                }
                return;
            };
            label("Updating…", false);
            // Windows: the updater closes Pulo, runs the installer, and the installer
            // starts the new version.
            if u.download_and_install(|_, _| {}, || {}).await.is_err() {
                label(&format!("Update failed. Retry Pulo {}", u.version), true);
                *PENDING.lock().unwrap() = Some(u);
            }
        })
    });
}
