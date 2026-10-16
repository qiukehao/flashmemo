//! File logging + panic capture for bug reports (2026-10-03). Logs live under
//! `%APPDATA%\FlashMemo\logs` (SPEC §14 data dir) as daily files
//! `flashmemo-YYYY-MM-DD.log`, keeping the most recent `KEEP_LOG_DAYS` days.
//! Rotation is done per-record by opening today's file in append mode — the
//! app writes only a few lines per minute at most, so this stays cheap while
//! avoiding an extra rotation dependency.
//!
//! Privacy: log messages must stay diagnostic (counts, ids, error strings);
//! never log card content or user text.

use chrono::{Duration as ChronoDuration, Local, NaiveDate};
use std::fs::OpenOptions;
use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};

pub const KEEP_LOG_DAYS: u32 = 7;
const FILE_PREFIX: &str = "flashmemo-";
const FILE_SUFFIX: &str = ".log";

/// `%APPDATA%\FlashMemo\logs`, or None when APPDATA is unavailable (then only
/// stderr logging stays active).
fn log_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|base| PathBuf::from(base).join("FlashMemo").join("logs"))
}

pub fn log_file_name(date: NaiveDate) -> String {
    format!("{FILE_PREFIX}{}{FILE_SUFFIX}", date.format("%Y-%m-%d"))
}

/// True when `name` is a rotated log strictly older than the kept window.
/// Malformed names are never stale (do not delete unknown files), and
/// `keep_days == 0` keeps everything.
pub fn is_stale_log(name: &str, today: NaiveDate, keep_days: u32) -> bool {
    if keep_days == 0 {
        return false;
    }
    let stem = name
        .strip_prefix(FILE_PREFIX)
        .and_then(|s| s.strip_suffix(FILE_SUFFIX));
    let Some(stem) = stem else {
        return false;
    };
    let Some(date) = NaiveDate::parse_from_str(stem, "%Y-%m-%d").ok() else {
        return false;
    };
    let oldest_kept = today - ChronoDuration::days((keep_days - 1) as i64);
    date < oldest_kept
}

/// Best-effort deletion of stale log files; individual failures are ignored.
pub fn prune_logs(dir: &Path, today: NaiveDate, keep_days: u32) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_stale_log(&name, today, keep_days) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn format_line(record: &log::Record) -> String {
    format!(
        "[{} {:<5} {}] {}",
        Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        record.level(),
        record.target(),
        record.args()
    )
}

/// fern already applied the dispatch-level `format` before handing the record
/// to `Output::call` — the args carry the full formatted line, so re-running
/// format_line here would double the prefix (caught live on 2026-10-03).
fn append_to_today_file(dir: &Path, record: &log::Record) {
    append_line(dir, &record.args().to_string());
}

/// Raw line append — shared by the logger and the panic hook. The panic hook
/// must NOT go through `log` (2026-10-05): if another thread happens to hold
/// the logger's internal lock when the process is going down, a hooked panic
/// would vanish without a trace. A direct append always lands.
fn append_line(dir: &Path, line: &str) {
    let path = dir.join(log_file_name(Local::now().date_naive()));
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let _ = writeln!(file, "{line}");
}

/// DIAGNOSTIC breadcrumb (2026-10-05 hang hunt): a lock-free direct append to
/// today's log, used to find the exact blocking call when the app freezes.
/// OFF by default (the daily logs stay readable); enable with the
/// `debug_breadcrumbs` setting when a freeze/silent-stop needs dissecting —
/// then grep `[BC]`.
static BREADCRUMBS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_breadcrumbs(enabled: bool) {
    BREADCRUMBS.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

pub fn breadcrumb(msg: &str) {
    if !BREADCRUMBS.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    if let Some(dir) = log_dir() {
        append_line(
            &dir,
            &format!(
                "[{} BC] {msg}",
                Local::now().format("%Y-%m-%d %H:%M:%S%.3f")
            ),
        );
    }
}

/// Install the file logger and a panic hook that records panics before the
/// default hook prints them. Best effort: if logging cannot start (APPDATA
/// missing, another logger already installed in tests), the app keeps running
/// with stderr only.
pub fn init() {
    let dir = log_dir();
    if let Some(d) = &dir {
        let _ = std::fs::create_dir_all(d);
        prune_logs(d, Local::now().date_naive(), KEEP_LOG_DAYS);
    }

    let builder = fern::Dispatch::new()
        .format(|out, _message, record| out.finish(format_args!("{}", format_line(record))))
        .level(log::LevelFilter::Info)
        // Our own modules log debug breadcrumbs (e.g. popup geometry) that are
        // invaluable in bug reports; third-party noise stays at Info.
        .level_for("flashmemo_lib", log::LevelFilter::Debug)
        .level_for("frontend", log::LevelFilter::Debug)
        .chain(std::io::stderr());
    let builder = match &dir {
        Some(d) => builder.chain(fern::Output::call({
            let d = d.clone();
            move |record| append_to_today_file(&d, record)
        })),
        None => builder,
    };
    if let Err(e) = builder.apply() {
        eprintln!("[logging] file logger not installed: {e}");
    }

    let default_hook = std::panic::take_hook();
    let hook_dir = dir.clone();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| l.to_string())
            .unwrap_or_else(|| "unknown location".into());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".into());
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed").to_string();
        let line = format!(
            "[{} ERROR flashmemo_lib::logging] [PANIC] thread '{name}' at {location}: {payload}",
            Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        );
        // Direct-to-file + stderr: independent of the log framework's locks.
        if let Some(d) = &hook_dir {
            append_line(d, &line);
        }
        eprintln!("{line}");
        default_hook(info);
    }));

    log::info!(
        "FlashMemo logging initialized (dir: {})",
        dir.as_ref()
            .map(|d| d.display().to_string())
            .unwrap_or_else(|| "unavailable, stderr only".into())
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_file_name_formats_iso_date() {
        let d = NaiveDate::from_ymd_opt(2026, 10, 3).unwrap();
        assert_eq!(log_file_name(d), "flashmemo-2026-10-03.log");
        let d = NaiveDate::from_ymd_opt(2026, 1, 7).unwrap();
        assert_eq!(log_file_name(d), "flashmemo-2026-01-07.log");
    }

    #[test]
    fn stale_log_respects_keep_window() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 3).unwrap();
        // keep 7 days: today and the previous 6 days survive.
        let kept = NaiveDate::from_ymd_opt(2026, 9, 27).unwrap();
        let stale = NaiveDate::from_ymd_opt(2026, 9, 26).unwrap();
        assert!(!is_stale_log(&log_file_name(today), today, 7));
        assert!(!is_stale_log(&log_file_name(kept), today, 7));
        assert!(is_stale_log(&log_file_name(stale), today, 7));
    }

    #[test]
    fn stale_log_never_deletes_unknown_names() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 3).unwrap();
        assert!(!is_stale_log("data.db", today, 7));
        assert!(!is_stale_log("flashmemo-not-a-date.log", today, 7));
        assert!(!is_stale_log("flashmemo-2026-10-03.log.bak", today, 7));
    }

    #[test]
    fn stale_log_zero_keep_days_keeps_everything() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 3).unwrap();
        let ancient = NaiveDate::from_ymd_opt(2020, 1, 1).unwrap();
        assert!(!is_stale_log(&log_file_name(ancient), today, 0));
    }

    #[test]
    fn stale_log_handles_month_rollover() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 2).unwrap();
        // 2026-02 has 28 days; keep 7 → oldest kept = 2026-02-24.
        let kept = NaiveDate::from_ymd_opt(2026, 2, 24).unwrap();
        let stale = NaiveDate::from_ymd_opt(2026, 2, 23).unwrap();
        assert!(!is_stale_log(&log_file_name(kept), today, 7));
        assert!(is_stale_log(&log_file_name(stale), today, 7));
    }

    /// Sanity: format_line must not lose the message payload and keeps the
    /// `[timestamp LEVEL target] message` shape.
    #[test]
    fn format_line_includes_level_and_message() {
        let record = log::Record::builder()
            .args(format_args!("popup failed"))
            .level(log::Level::Error)
            .target("flashmemo_lib::engine")
            .build();
        let line = format_line(&record);
        assert!(line.starts_with('['));
        assert!(line.contains("ERROR"));
        assert!(line.contains("flashmemo_lib::engine"));
        assert!(line.ends_with("popup failed"));
    }
}
