//! The island's Screenshot page: take one, and the latest from Pictures\Screenshots (where
//! Win+PrtScn and the Snipping Tool save them).

use serde::Serialize;
use std::path::PathBuf;
use tauri::ipc::Response;

fn folder() -> Option<PathBuf> {
    use windows::Win32::{System::Com::CoTaskMemFree, UI::Shell::*};
    unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_Screenshots, KF_FLAG_DEFAULT, None).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as _));
        s.map(PathBuf::from)
    }
}

/// The webview names a screenshot by its file name only: nothing that could reach outside
/// the folder.
fn safe_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\', ':']) && name != "." && name != ".."
}

#[derive(Serialize)]
pub struct Shot {
    name: String,
    at: i64, // ms since the epoch
}

/// Newest first, up to 6 images.
#[tauri::command]
pub async fn screenshots() -> Vec<Shot> {
    let Some(Ok(dir)) = folder().map(std::fs::read_dir) else { return vec![] };
    let mut shots: Vec<Shot> = dir
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let ext = name.rsplit('.').next()?.to_ascii_lowercase();
            ["png", "jpg", "jpeg"].contains(&ext.as_str()).then_some(())?;
            let at = e.metadata().ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
            Some(Shot { name, at })
        })
        .collect();
    shots.sort_by_key(|s| -s.at);
    shots.truncate(6);
    shots
}

#[tauri::command]
pub async fn screenshot_image(name: String) -> Result<Response, String> {
    if !safe_name(&name) {
        return Err("Not a screenshot".into());
    }
    let path = folder().ok_or("No Screenshots folder")?.join(name);
    std::fs::read(path).map(Response::new).map_err(|e| e.to_string())
}

/// Open one in the default viewer, or the folder itself.
#[tauri::command]
pub async fn open_screenshot(name: Option<String>) {
    let Some(dir) = folder() else { return };
    match name {
        Some(n) if safe_name(&n) => crate::sys::open_path(&dir.join(n).to_string_lossy()),
        Some(_) => {}
        None => crate::sys::open_path(&dir.to_string_lossy()),
    }
}

/// The whole screen, saved to the folder (Win+PrtScn). Waits for the island to close first,
/// so it isn't in the picture.
#[tauri::command]
pub async fn screenshot_full() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_LWIN, VK_SNAPSHOT};
    std::thread::sleep(std::time::Duration::from_millis(600));
    crate::sys::press(&[VK_LWIN, VK_SNAPSHOT]);
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_plain_names() {
        assert!(super::safe_name("Screenshot 2026-11-22 210102.png"));
        for bad in ["", ".", "..", "../x.png", r"..\x.png", r"C:\x.png", "a/b.png"] {
            assert!(!super::safe_name(bad), "{bad}");
        }
    }
}
