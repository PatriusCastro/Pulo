//! Live equalizer bars from WASAPI loopback capture (whatever the speakers are playing).
//! Runs only while the UI asks for it (expanded panel + music playing); otherwise idle.

use crate::sys::APP;
use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed},
    thread,
    time::Duration,
};
use tauri::Emitter;
use windows::{
    core::Result,
    Win32::{
        Media::Audio::*,
        System::Com::*,
    },
};

pub static ON: AtomicBool = AtomicBool::new(false);
/// Milliseconds between updates sent to the UI: as often as the bars on screen repaint,
/// since every update costs the webview work.
pub static INTERVAL_MS: AtomicU64 = AtomicU64::new(33);

/// Band centers in Hz, low to high.
const BANDS: [f32; 5] = [60.0, 250.0, 1000.0, 4000.0, 12000.0];

/// RBJ band-pass biquad (constant 0 dB peak gain).
#[derive(Default)]
struct Biquad {
    b0: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    fn bandpass(f0: f32, fs: f32, q: f32) -> Self {
        let w = std::f32::consts::TAU * f0 / fs;
        let alpha = w.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Biquad { b0: alpha / a0, b2: -alpha / a0, a1: -2.0 * w.cos() / a0, a2: (1.0 - alpha) / a0, ..Default::default() }
    }
    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        (self.x2, self.x1, self.y2, self.y1) = (self.x1, x, self.y1, y);
        y
    }
}

/// RMS level -> 0..1 on a -60..0 dB scale.
fn level(sum_sq: f32, n: usize) -> f32 {
    if n == 0 {
        return 0.0;
    }
    let db = 20.0 * (sum_sq / n as f32).sqrt().max(1e-6).log10();
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

/// Bar height from a band level, measured against that band's recent average (`avg`, updated
/// here). Mastered music sits near the top of the fixed dB scale all the time, so absolute
/// levels barely move; the swing around the average is what reads as the beat. Scaled by the
/// level itself so silence still drops the bar.
fn bounce(t: f32, avg: &mut f32) -> f32 {
    *avg = *avg * 0.94 + t * 0.06;
    ((0.45 + (t - *avg) * 6.0) * (t * 2.0).min(1.0)).clamp(0.0, 1.0)
}

/// Blocks forever; run on its own thread.
pub fn run() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    loop {
        if ON.load(Relaxed) {
            let _ = capture(); // returns when switched off, or on a device error
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn capture() -> Result<()> {
    unsafe {
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let client: IAudioClient = en.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)?;
        let fmt = client.GetMixFormat()?;
        let (fs, ch, bits) = ((*fmt).nSamplesPerSec as f32, (*fmt).nChannels as usize, (*fmt).wBitsPerSample);
        let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 1_000_000, 0, fmt, None);
        CoTaskMemFree(Some(fmt as _));
        init?;
        // ponytail: shared-mode mix format is 32-bit float on every Windows 10/11 setup seen;
        // other formats just show no bars.
        if bits != 32 || ch == 0 {
            return Ok(());
        }
        let cap: IAudioCaptureClient = client.GetService()?;
        let mut filters: Vec<Biquad> = BANDS.iter().map(|&f| Biquad::bandpass(f.min(fs * 0.45), fs, 1.4)).collect();
        let mut shown = [0f32; 5];
        let mut avg = [0f32; 5];
        let mut sent = [0f32; 5];
        client.Start()?;
        while ON.load(Relaxed) {
            thread::sleep(Duration::from_millis(INTERVAL_MS.load(Relaxed)));
            let mut energy = [0f32; 5];
            let mut n = 0usize;
            while cap.GetNextPacketSize()? > 0 {
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                let samples = std::slice::from_raw_parts(data as *const f32, frames as usize * ch);
                for frame in samples.chunks_exact(ch) {
                    let x = if silent { 0.0 } else { frame.iter().sum::<f32>() / ch as f32 };
                    for (e, f) in energy.iter_mut().zip(filters.iter_mut()) {
                        let y = f.run(x);
                        *e += y * y;
                    }
                    n += 1;
                }
                cap.ReleaseBuffer(frames)?;
            }
            // Fall at the same speed whatever the frame rate (0.7 per 50 ms).
            let k = 0.7f32.powf(INTERVAL_MS.load(Relaxed) as f32 / 50.0);
            for ((s, a), e) in shown.iter_mut().zip(avg.iter_mut()).zip(energy) {
                let target = bounce(level(e, n), a);
                // Jump up instantly, fall back gently.
                *s = if target > *s { target } else { *s * k + target * (1.0 - k) };
            }
            // Each frame costs the page a restyle and a repaint: skip ones nobody could see
            // (under half a pixel), such as quiet passages and bars that have settled.
            if shown.iter().zip(&sent).any(|(a, b)| (a - b).abs() > 0.02) {
                sent = shown;
                if let Some(app) = APP.get() {
                    let _ = app.emit("eq", shown);
                }
            }
        }
        let _ = client.Stop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each band filter passes its own frequency and rejects one far away.
    #[test]
    fn bands_separate_tones() {
        let fs = 48_000.0;
        let tone = |hz: f32, band: f32| {
            let mut f = Biquad::bandpass(band, fs, 1.4);
            let n = 9600;
            let e: f32 = (0..n).map(|i| f.run((std::f32::consts::TAU * hz * i as f32 / fs).sin()).powi(2)).sum();
            level(e, n)
        };
        for &b in &BANDS {
            assert!(tone(b, b) > 0.9, "band {b} should pass its own tone");
        }
        // Rejected tones must sit at least ~30 dB under a passed one (0.5 on the 60 dB scale).
        assert!(tone(60.0, 4000.0) < 0.45, "4 kHz band should reject 60 Hz");
        assert!(tone(12000.0, 250.0) < 0.45, "250 Hz band should reject 12 kHz");
        assert_eq!(level(0.0, 0), 0.0);
    }

    /// A loud, steady band settles mid-height, a beat above it jumps, and silence stays flat.
    #[test]
    fn bounce_follows_changes_not_loudness() {
        let mut a = 0.0;
        for _ in 0..200 {
            bounce(0.85, &mut a);
        }
        let steady = bounce(0.85, &mut a);
        assert!((0.35..0.55).contains(&steady), "steady {steady}");
        assert!(bounce(0.95, &mut a) > steady + 0.3, "a beat should jump");
        let mut q = 0.0;
        assert_eq!(bounce(0.0, &mut q), 0.0);
    }
}
