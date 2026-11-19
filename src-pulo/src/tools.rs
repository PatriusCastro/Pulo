//! Quick toggles in the island's Tools tab: dark mode, mic mute, keep awake, lock, empty
//! Recycle Bin.

use crate::sys::APP;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use tauri::Emitter;
use windows::{
    core::{implement, w, Result, PCWSTR},
    Win32::{
        Foundation::{LPARAM, WPARAM},
        Media::Audio::{Endpoints::*, *},
        System::{Com::*, Power::*, Registry::*},
        UI::{Shell::SHEmptyRecycleBinW, WindowsAndMessaging::*},
    },
};

/// Keep awake, applied by the 1 Hz loop in lib.rs (see hold_awake). Off at every launch.
pub static AWAKE: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
pub struct State {
    dark: bool,
    mic_muted: bool,
    awake: bool,
}

const THEME: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");

fn dark() -> bool {
    let (mut v, mut n) = (1u32, 4u32);
    unsafe {
        let _ = RegGetValueW(HKEY_CURRENT_USER, THEME, w!("AppsUseLightTheme"), RRF_RT_REG_DWORD, None, Some(&mut v as *mut u32 as _), Some(&mut n));
    }
    v == 0
}

/// Same switch as Settings > Personalization > Colors: apps and Windows together.
fn set_dark(on: bool) {
    let light = u32::from(!on);
    unsafe {
        for name in [w!("AppsUseLightTheme"), w!("SystemUsesLightTheme")] {
            let _ = RegSetKeyValueW(HKEY_CURRENT_USER, THEME, name, REG_DWORD.0, Some(&light as *const u32 as _), 4);
        }
        // Running apps re-read the theme when told it changed.
        let _ = SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(w!("ImmersiveColorSet").as_ptr() as isize), SMTO_ABORTIFHUNG, 200, None);
    }
}

/// The default microphone's volume control.
fn mic() -> Result<IAudioEndpointVolume> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED); // no-op if this thread already has COM
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        en.GetDefaultAudioEndpoint(eCapture, eConsole)?.Activate(CLSCTX_ALL, None)
    }
}

fn mic_muted() -> bool {
    mic().and_then(|m| unsafe { m.GetMute() }).is_ok_and(|b| b.as_bool())
}

#[implement(IAudioEndpointVolumeCallback)]
struct MicCb;

impl IAudioEndpointVolumeCallback_Impl for MicCb_Impl {
    fn OnNotify(&self, data: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> Result<()> {
        // Also called on every level change, which call apps' auto-gain does constantly:
        // only pass on a change of mute.
        static LAST: AtomicBool = AtomicBool::new(false);
        let muted = unsafe { (*data).bMuted.as_bool() };
        if LAST.swap(muted, Relaxed) != muted {
            if let Some(app) = APP.get() {
                let _ = app.emit("mic", muted);
            }
        }
        Ok(())
    }
}

/// Follow mute changes from anywhere (Teams, the keyboard, Pulo). Call on a thread that
/// stays alive, like sys::watch_volume.
// ponytail: the default mic at startup only, like watch_volume.
pub fn watch_mic() -> Result<()> {
    let ep = mic()?;
    unsafe { ep.RegisterControlChangeNotify(&IAudioEndpointVolumeCallback::from(MicCb))? };
    std::mem::forget(ep); // keep the registration alive for the life of the process
    Ok(())
}

/// Keep the screen on and the PC awake, or stop. The request belongs to the calling
/// thread, so call it from one that lives as long as the app.
pub fn hold_awake(on: bool) {
    let flags = if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED } else { ES_CONTINUOUS };
    unsafe {
        SetThreadExecutionState(flags);
    }
}

#[tauri::command]
pub async fn tools_state() -> State {
    State { dark: dark(), mic_muted: mic_muted(), awake: AWAKE.load(Relaxed) }
}

/// Fixed list, like `launch`: the webview can only pick one of these.
#[tauri::command]
pub async fn tool(action: String) -> State {
    match action.as_str() {
        "dark" => set_dark(!dark()),
        "mic" => {
            if let Ok(m) = mic() {
                unsafe {
                    let muted = m.GetMute().is_ok_and(|b| b.as_bool());
                    let _ = m.SetMute(!muted, std::ptr::null());
                }
            }
        }
        "awake" => {
            AWAKE.fetch_xor(true, Relaxed);
        }
        "lock" => unsafe {
            let _ = windows::Win32::System::Shutdown::LockWorkStation();
        },
        // Flags 0: Windows asks for confirmation itself.
        "empty_bin" => unsafe {
            let _ = SHEmptyRecycleBinW(None, PCWSTR::null(), 0);
        },
        _ => {}
    }
    tools_state().await
}
