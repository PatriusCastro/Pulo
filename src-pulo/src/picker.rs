//! Eyedropper: after `pick_color`, the next left click anywhere on screen picks that
//! pixel's colour (the click doesn't reach the app under it). Right click or Esc cancels;
//! so does doing nothing for 30 s, since the crosshair replaces the system cursors.

use crate::sys::APP;
use std::sync::{
    atomic::{AtomicBool, Ordering::Relaxed},
    Mutex,
};
use tauri::Emitter;
use windows::Win32::{
    Foundation::*,
    Graphics::Gdi::{GetDC, GetPixel, ReleaseDC},
    UI::WindowsAndMessaging::*,
};

static PICKING: AtomicBool = AtomicBool::new(false);
static PICKED: Mutex<Option<POINT>> = Mutex::new(None);
/// Latest first, without repeats.
static HISTORY: Mutex<Vec<String>> = Mutex::new(Vec::new());
const KEEP: usize = 12;

fn hex(c: COLORREF) -> String {
    let (r, g, b) = (c.0 & 0xff, (c.0 >> 8) & 0xff, (c.0 >> 16) & 0xff); // 0x00BBGGRR
    format!("#{r:02X}{g:02X}{b:02X}")
}

unsafe extern "system" fn on_mouse(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0 {
        let pt = unsafe { (*(lp.0 as *const MSLLHOOKSTRUCT)).pt };
        match wp.0 as u32 {
            WM_LBUTTONDOWN => {
                *PICKED.lock().unwrap() = Some(pt);
                return LRESULT(1);
            }
            WM_RBUTTONDOWN => return LRESULT(1),
            // Done on button up, so the app under the cursor sees neither half of the click.
            WM_LBUTTONUP | WM_RBUTTONUP => {
                unsafe { PostQuitMessage(0) };
                return LRESULT(1);
            }
            _ => {}
        }
    }
    unsafe { CallNextHookEx(None, code, wp, lp) }
}

unsafe extern "system" fn on_key(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0 && wp.0 as u32 == WM_KEYDOWN && unsafe { (*(lp.0 as *const KBDLLHOOKSTRUCT)).vkCode } == 0x1B {
        *PICKED.lock().unwrap() = None;
        unsafe { PostQuitMessage(0) };
        return LRESULT(1);
    }
    unsafe { CallNextHookEx(None, code, wp, lp) }
}

#[tauri::command]
pub fn pick_color() {
    if PICKING.swap(true, Relaxed) {
        return;
    }
    *PICKED.lock().unwrap() = None;
    std::thread::spawn(|| unsafe {
        if let Ok(cross) = LoadCursorW(None, IDC_CROSS) {
            for id in [OCR_NORMAL, OCR_IBEAM, OCR_HAND] {
                // SetSystemCursor takes ownership of the cursor it's given, so give it a copy.
                if let Ok(c) = CopyIcon(HICON(cross.0)) {
                    let _ = SetSystemCursor(HCURSOR(c.0), id);
                }
            }
        }
        let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), None, 0);
        let keys = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), None, 0);
        let _ = SetTimer(None, 0, 30_000, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_TIMER {
                break;
            }
        }
        for h in [mouse, keys].into_iter().flatten() {
            let _ = UnhookWindowsHookEx(h);
        }
        let _ = SystemParametersInfoW(SPI_SETCURSORS, 0, None, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)); // back to the user's cursors
        let picked = PICKED.lock().unwrap().take();
        PICKING.store(false, Relaxed);
        let Some(pt) = picked else { return };
        let dc = GetDC(None);
        let c = GetPixel(dc, pt.x, pt.y); // physical pixels: the process is per-monitor DPI aware
        ReleaseDC(None, dc);
        if c.0 == u32::MAX {
            // CLR_INVALID: off every screen
            return;
        }
        let h = hex(c);
        {
            let mut list = HISTORY.lock().unwrap();
            list.retain(|x| *x != h);
            list.insert(0, h.clone());
            list.truncate(KEEP);
        }
        let _ = tauri::async_runtime::block_on(crate::clip::clip_copy(h.clone()));
        if let Some(app) = APP.get() {
            let _ = app.emit("color_picked", h);
        }
    });
}

#[tauri::command]
pub fn colors() -> Vec<String> {
    HISTORY.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    #[test]
    fn hex_is_rgb() {
        assert_eq!(super::hex(windows::Win32::Foundation::COLORREF(0x00FF_8010)), "#1080FF");
    }
}
