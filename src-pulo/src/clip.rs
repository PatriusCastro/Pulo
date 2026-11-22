//! Windows' clipboard history (the list Win+V shows), read and pasted from the island.
//! Windows keeps the history and its settings (on/off, pinned items, sync); Pulo stores nothing.

use serde::Serialize;
use windows::ApplicationModel::DataTransfer::{Clipboard, ClipboardHistoryItem, ClipboardHistoryItemsResultStatus, StandardDataFormats};

#[derive(Serialize)]
pub struct Clip {
    id: String,
    text: Option<String>, // None for an image
    image: bool,
    at: i64, // ms since the epoch
}

/// The history, newest first; None when it's off in Windows Settings (or Windows refuses).
fn items() -> windows::core::Result<Option<Vec<ClipboardHistoryItem>>> {
    if !Clipboard::IsHistoryEnabled()? {
        return Ok(None);
    }
    let r = Clipboard::GetHistoryItemsAsync()?.get()?;
    if r.Status()? != ClipboardHistoryItemsResultStatus::Success {
        return Ok(None);
    }
    Ok(Some(r.Items()?.into_iter().collect()))
}

/// Windows' clipboard classes only work on a single-threaded apartment, which Tauri's worker
/// threads aren't: run the call on a short-lived thread of its own that is.
fn sta<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    std::thread::spawn(move || {
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        f()
    })
    .join()
    .map_err(|_| "Clipboard history failed".to_string())?
}

fn find(id: &str) -> Result<ClipboardHistoryItem, String> {
    items()
        .map_err(|e| e.message())?
        .and_then(|v| v.into_iter().find(|it| it.Id().is_ok_and(|i| i == id)))
        .ok_or_else(|| "That item is no longer in the clipboard history".into())
}

/// Text and images, up to 25. Other formats (files, HTML only) are left out.
#[tauri::command]
pub async fn clip_history() -> Result<Option<Vec<Clip>>, String> {
    sta(history)
}
fn history() -> Result<Option<Vec<Clip>>, String> {
    let Some(list) = items().map_err(|e| e.message())? else { return Ok(None) };
    let (text_fmt, image_fmt) = (StandardDataFormats::Text().map_err(|e| e.message())?, StandardDataFormats::Bitmap().map_err(|e| e.message())?);
    Ok(Some(
        list.iter()
            .filter_map(|it| {
                let c = it.Content().ok()?;
                let text = c.Contains(&text_fmt).ok()?.then(|| c.GetTextAsync().ok()?.get().ok()).flatten();
                let image = text.is_none() && c.Contains(&image_fmt).unwrap_or(false);
                if text.is_none() && !image {
                    return None;
                }
                // 100 ns ticks since 1601 -> ms since 1970.
                let at = (it.Timestamp().ok()?.UniversalTime - 116_444_736_000_000_000) / 10_000;
                Some(Clip { id: it.Id().ok()?.to_string(), text: text.map(|t| t.to_string().chars().take(2000).collect()), image, at })
            })
            .take(25)
            .collect(),
    ))
}

/// Put the item on the clipboard and paste it into the app you were in: the island never
/// takes focus, so that app still has it, as with Win+V.
#[tauri::command]
pub async fn clip_paste(id: String) -> Result<(), String> {
    sta(move || paste(&id))
}
fn paste(id: &str) -> Result<(), String> {
    use windows::ApplicationModel::DataTransfer::SetHistoryItemAsContentStatus;
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_CONTROL, VK_V};
    let it = find(id)?;
    if Clipboard::SetHistoryItemAsContent(&it).map_err(|e| e.message())? != SetHistoryItemAsContentStatus::Success {
        return Err("Windows wouldn't put that item on the clipboard".into());
    }
    std::thread::sleep(std::time::Duration::from_millis(60)); // let the clipboard settle first
    crate::sys::press(&[VK_CONTROL, VK_V]);
    Ok(())
}

#[tauri::command]
pub async fn clip_delete(id: String) -> Result<(), String> {
    sta(move || Clipboard::DeleteItemFromHistory(&find(&id)?).map(|_| ()).map_err(|e| e.message()))
}

/// Clears what isn't pinned, as Windows' own Clear all does.
#[tauri::command]
pub async fn clip_clear() -> Result<(), String> {
    sta(|| Clipboard::ClearHistory().map(|_| ()).map_err(|e| e.message()))
}

/// An image item's picture, as the bytes of its file (PNG or BMP), for the island to show.
#[tauri::command]
pub async fn clip_image(id: String) -> Result<tauri::ipc::Response, String> {
    sta(move || {
        let read = || -> windows::core::Result<Vec<u8>> {
            let it = find(&id).map_err(|e| windows::core::Error::new(windows::core::HRESULT(-1), e))?;
            let stream = it.Content()?.GetBitmapAsync()?.get()?.OpenReadAsync()?.get()?;
            let size = stream.Size()? as u32;
            let reader = windows::Storage::Streams::DataReader::CreateDataReader(&stream)?;
            reader.LoadAsync(size)?.get()?;
            let mut buf = vec![0u8; size as usize];
            reader.ReadBytes(&mut buf)?;
            Ok(buf)
        };
        read().map(tauri::ipc::Response::new).map_err(|e| e.message())
    })
}

/// Put text on the clipboard (the calculator's Copy). The webview's own clipboard API needs
/// focus, which the island never has.
#[tauri::command]
pub async fn clip_copy(text: String) -> Result<(), String> {
    use windows::ApplicationModel::DataTransfer::DataPackage;
    sta(move || {
        let p = DataPackage::new().map_err(|e| e.message())?;
        p.SetText(&windows::core::HSTRING::from(text)).map_err(|e| e.message())?;
        Clipboard::SetContent(&p).map_err(|e| e.message())?;
        Clipboard::Flush().map_err(|e| e.message()) // stays after Pulo quits
    })
}

#[cfg(test)]
mod tests {
    // Reads the real history; prints only counts. Run: cargo test clip -- --ignored --nocapture
    #[test]
    #[ignore]
    fn reads_history() {
        let r = match tauri::async_runtime::block_on(super::clip_history()) {
            Ok(r) => r,
            Err(e) => return println!("error: {e}"),
        };
        let items = r.unwrap_or_default();
        println!("items: {}, images: {}", items.len(), items.iter().filter(|c| c.image).count());
        if let Some(c) = items.iter().find(|c| c.image) {
            let bytes = tauri::async_runtime::block_on(super::clip_image(c.id.clone()));
            println!("first image: {}", if bytes.is_ok() { "read" } else { "failed" });
        }
    }
}
