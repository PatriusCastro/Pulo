//! AI agent tracker. Follows Claude Code's session logs (~/.claude/projects/<project>/<id>.jsonl),
//! reading only the lines appended since the last read.
// ponytail: Claude Code only. Codex (~/.codex/sessions) and Copilot get their own `apply`
// once their logs exist on a machine to test against.

use crate::sys::{watch_dir, APP};
use chrono::{DateTime, Local, NaiveDate, TimeZone};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};
use tauri::Emitter;
use windows::Win32::Storage::FileSystem::*;

/// Only announce turns that ran at least this long; quick replies aren't worth a notice.
const LONG_TURN_MS: i64 = 20_000;

#[derive(Serialize, Clone, PartialEq)]
pub struct Session {
    agent: &'static str,
    title: String,
    project: String,
    working: bool,
    since: i64, // ms since epoch the current turn started; meaningful while working
    last: i64,  // ms since epoch of the latest main-chain entry
    model: String,
}

#[derive(Serialize, Clone, PartialEq)]
pub struct Agents {
    sessions: Vec<Session>, // most recent first
    tokens_today: u64,
}

pub static AGENTS: Mutex<Agents> = Mutex::new(Agents { sessions: Vec::new(), tokens_today: 0 });

#[derive(Default)]
struct Log {
    offset: u64,
    title: String,
    project: String,
    working: bool,
    since: i64,
    last: i64,
    model: String,
    counted: HashMap<String, (NaiveDate, u64)>, // message id -> tokens already counted
}

#[derive(Default)]
struct Tracker {
    logs: HashMap<PathBuf, Log>,
}

fn day(ms: i64) -> Option<NaiveDate> {
    Local.timestamp_millis_opt(ms).single().map(|d| d.date_naive())
}

fn text_of(content: &Value) -> &str {
    content.as_str().or_else(|| content[0]["text"].as_str()).unwrap_or("")
}

/// Fold one log entry into the session. Returns Some(turn length in ms) when a turn ends.
fn apply(log: &mut Log, v: &Value) -> Option<i64> {
    let ty = v["type"].as_str().unwrap_or("");
    if ty == "ai-title" {
        log.title = v["aiTitle"].as_str().unwrap_or_default().to_string();
        return None;
    }
    if ty != "user" && ty != "assistant" {
        return None;
    }
    let ts = v["timestamp"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|d| d.timestamp_millis())?;
    let m = &v["message"];

    // Tokens, subagents included. Streaming writes one entry per content block with the
    // same message id, so count each id once, keeping the largest usage seen.
    if let (Some(id), Some(u)) = (m["id"].as_str(), m.get("usage")) {
        let n = ["input_tokens", "cache_creation_input_tokens", "output_tokens"].iter().map(|k| u[*k].as_u64().unwrap_or(0)).sum();
        let e = log.counted.entry(id.to_string()).or_insert((day(ts)?, 0));
        e.1 = e.1.max(n);
    }

    if v["isSidechain"].as_bool() == Some(true) || v["isMeta"].as_bool() == Some(true) {
        return None; // subagent traffic and local command echoes don't change the main state
    }
    // "<synthetic>" marks entries Claude Code writes itself, like API errors.
    if let Some(model) = m["model"].as_str().filter(|s| !s.starts_with('<')) {
        log.model = model.to_string();
    }
    if let Some(cwd) = v["cwd"].as_str() {
        log.project = cwd.rsplit(['\\', '/']).next().unwrap_or(cwd).to_string();
    }
    log.last = log.last.max(ts);
    let start = |log: &mut Log| {
        if !log.working {
            log.working = true;
            log.since = ts;
        }
    };
    match (ty, m["stop_reason"].as_str()) {
        ("user", _) if text_of(&m["content"]).starts_with("[Request interrupted") => {
            log.working = false;
            None
        }
        ("user", _) | ("assistant", Some("tool_use") | None) => {
            start(log);
            None
        }
        ("assistant", Some(_)) if log.working => {
            log.working = false;
            Some(ts - log.since)
        }
        _ => None,
    }
}

impl Tracker {
    /// Read lines appended to `path` since last time. Returns finished long turns.
    fn read_new(&mut self, path: &Path) -> Vec<(String, String)> {
        let mut done = Vec::new();
        let log = self.logs.entry(path.to_path_buf()).or_default();
        let Ok(mut f) = File::open(path) else { return done };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < log.offset {
            *log = Log::default(); // file was rewritten
        }
        let mut buf = Vec::new();
        if f.seek(SeekFrom::Start(log.offset)).is_err() || f.read_to_end(&mut buf).is_err() {
            return done;
        }
        let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { return done }; // only whole lines
        log.offset += end as u64 + 1;
        for line in buf[..end].split(|&b| b == b'\n') {
            let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
            if let Some(ms) = apply(log, &v) {
                if ms >= LONG_TURN_MS {
                    let title = if log.title.is_empty() { log.project.clone() } else { log.title.clone() };
                    done.push((title, log.project.clone()));
                }
            }
        }
        done
    }

    fn snapshot(&self) -> Agents {
        let today = Local::now().date_naive();
        let cutoff = Local::now().timestamp_millis() - 24 * 3_600_000;
        let mut sessions: Vec<Session> = self
            .logs
            .values()
            .filter(|l| l.last > cutoff)
            .map(|l| Session {
                agent: "Claude",
                title: l.title.clone(),
                project: l.project.clone(),
                working: l.working,
                since: l.since,
                last: l.last,
                model: l.model.clone(),
            })
            .collect();
        sessions.sort_by(|a, b| b.last.cmp(&a.last));
        sessions.truncate(5);
        let tokens_today = self.logs.values().flat_map(|l| l.counted.values()).filter(|(d, _)| *d == today).map(|(_, n)| n).sum();
        Agents { sessions, tokens_today }
    }

    fn publish(&self) {
        let snap = self.snapshot();
        let mut cur = AGENTS.lock().unwrap();
        if *cur != snap {
            *cur = snap.clone();
            drop(cur);
            if let Some(app) = APP.get() {
                let _ = app.emit("agents", snap);
            }
        }
    }
}

/// Blocks forever; run on its own thread.
pub fn watch() -> windows::core::Result<()> {
    let root = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".claude").join("projects");
    let mut t = Tracker::default();
    // Catch up silently on the last day's logs so the first notice is a real one.
    let day_ago = SystemTime::now() - Duration::from_secs(24 * 3600);
    for dir in fs::read_dir(&root).into_iter().flatten().flatten() {
        for file in fs::read_dir(dir.path()).into_iter().flatten().flatten() {
            let p = file.path();
            let recent = file.metadata().and_then(|m| m.modified()).is_ok_and(|t| t > day_ago);
            if recent && p.extension().is_some_and(|e| e == "jsonl") {
                t.read_new(&p);
            }
        }
    }
    t.publish();

    let filter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE;
    watch_dir(&root.to_string_lossy(), true, filter, |batch| {
        let mut files: Vec<String> = batch.into_iter().map(|(_, n)| n).filter(|n| n.ends_with(".jsonl")).collect();
        files.sort();
        files.dedup();
        for name in files {
            for (title, project) in t.read_new(&root.join(&name)) {
                if let Some(app) = APP.get() {
                    let _ = app.emit("agent_done", (title, project));
                }
            }
        }
        t.publish();
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn turn_lifecycle_and_tokens() {
        let mut log = Log::default();
        let usage = r#""usage":{"input_tokens":10,"cache_creation_input_tokens":5,"output_tokens":7,"cache_read_input_tokens":999}"#;
        assert_eq!(apply(&mut log, &line(r#"{"type":"user","timestamp":"2026-11-18T10:00:00Z","cwd":"D:\\Projects\\pulo","message":{"role":"user","content":"hi"}}"#)), None);
        assert!(log.working);
        assert_eq!(log.project, "pulo");
        // tool call, streamed as two entries for the same message id
        let tool = format!(r#"{{"type":"assistant","timestamp":"2026-11-18T10:00:05Z","message":{{"id":"m1","model":"claude-opus-5-5","stop_reason":"tool_use","content":[],{usage}}}}}"#);
        assert_eq!(apply(&mut log, &line(&tool)), None);
        assert_eq!(apply(&mut log, &line(&tool)), None);
        assert_eq!(log.model, "claude-opus-5-5");
        apply(&mut log, &line(r#"{"type":"assistant","timestamp":"2026-11-18T10:00:06Z","message":{"model":"<synthetic>","stop_reason":"tool_use"}}"#));
        assert_eq!(log.model, "claude-opus-5-5"); // Claude Code's own entries don't count as a model
        // subagent traffic counts tokens but not state
        let side = format!(r#"{{"type":"assistant","isSidechain":true,"timestamp":"2026-11-18T10:00:10Z","message":{{"id":"s1","stop_reason":"end_turn",{usage}}}}}"#);
        assert_eq!(apply(&mut log, &line(&side)), None);
        assert!(log.working);
        let end = format!(r#"{{"type":"assistant","timestamp":"2026-11-18T10:00:30Z","message":{{"id":"m2","stop_reason":"end_turn",{usage}}}}}"#);
        assert_eq!(apply(&mut log, &line(&end)), Some(30_000));
        assert!(!log.working);
        assert_eq!(log.counted.values().map(|(_, n)| n).sum::<u64>(), 3 * 22); // m1, s1, m2; cache reads excluded
        // a second end entry for the same message doesn't announce twice
        assert_eq!(apply(&mut log, &line(&end)), None);
        // interrupt clears working
        apply(&mut log, &line(r#"{"type":"user","timestamp":"2026-11-18T10:01:00Z","message":{"content":"go"}}"#));
        apply(&mut log, &line(r#"{"type":"user","timestamp":"2026-11-18T10:01:02Z","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#));
        assert!(!log.working);
    }
}
