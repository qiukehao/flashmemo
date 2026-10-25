//! Tauri command layer: thin invoke wrappers that lock the managed database
//! and delegate to `services`. No business logic lives here.

use crate::db::Db;
use crate::import::ImportReport;
use crate::services::{
    self, CardDto, DeckOverview, ExportReport, ImportFile, ImportPreview, ReviewSession,
};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Manager, State};

type DbState<'a> = State<'a, Mutex<Db>>;
type SessionState<'a> = State<'a, ReviewSession>;

fn lock<'a>(db: &'a DbState<'a>) -> std::sync::MutexGuard<'a, Db> {
    db.lock().unwrap_or_else(crate::recover_lock)
}

/// Frontend diagnostics funnel into the same log file as the Rust side, so a
/// bug report only needs one artifact. Level comes from the UI and is mapped
/// defensively; messages are error strings and component state, never card
/// content.
#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!(target: "frontend", "{message}"),
        "warn" => log::warn!(target: "frontend", "{message}"),
        "info" => log::info!(target: "frontend", "{message}"),
        _ => log::debug!(target: "frontend", "{message}"),
    }
}

/// Popup queue: a pending manual selection first, else the due queue sized by
/// SPEC §7.4 — `min(每次弹窗卡片数, 候选数)`. A pending manual session ignores
/// the size entirely (the user picked those cards; see `services::review_queue`).
#[tauri::command]
pub fn review_queue(
    session: SessionState,
    db: DbState,
    app: tauri::AppHandle,
) -> Result<Vec<CardDto>, String> {
    crate::logging::breadcrumb("cmd:review-queue-in");
    // 连续关闭惩罚: the engine caps the next due-queue popup to 1 card. A
    // lock-free atomic read — never a mutex the engine may hold across window
    // operations (that deadlocked the app, see EngineShared).
    let dodge_cap = app
        .try_state::<crate::engine::EngineShared>()
        .map(|s| {
            s.session_size_override
                .load(std::sync::atomic::Ordering::Relaxed)
        })
        .unwrap_or(0);
    let r = {
        let guard = lock(&db);
        let size = services::session_size(services::per_popup_size(&guard), dodge_cap);
        services::review_queue(&guard, &session, size)
    };
    crate::logging::breadcrumb("cmd:review-queue-out");
    r
}

/// Start a review session over explicit cards and open the popup at once.
#[tauri::command]
pub fn start_review(
    card_ids: Vec<i64>,
    session: SessionState,
    db: DbState,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let cards = {
        let guard = lock(&db);
        services::cards_by_ids(&guard, &card_ids)?
    };
    if cards.is_empty() {
        return Err("选中的卡片不存在".into());
    }
    let ids: Vec<i64> = cards.iter().map(|c| c.id).collect();
    let n = ids.len();
    services::set_review_session(&session, ids);
    // Do not synchronously create a Webview2 window from an invoke handler on
    // Windows. Tauri documents that this can deadlock the UI thread and leave
    // a blank, unresponsive popup. The session is stored first, then the
    // window is created on a detached worker thread.
    std::thread::spawn(move || {
        if !crate::engine::open_review_popup(&app) {
            log::error!("[review] failed to open popup window after start_review");
        }
    });
    Ok(n)
}

/// "学新卡" home-page trigger: open a popup session over the remaining daily
/// new-card quota (per-session quota does not apply; the daily one does).
#[tauri::command]
pub fn start_new_review(
    session: SessionState,
    db: DbState,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let cards = services::new_cards_queue(&lock(&db))?;
    let ids: Vec<i64> = cards.iter().map(|c| c.id).collect();
    let n = ids.len();
    services::set_review_session(&session, ids);
    // Same off-thread popup creation as start_review (WebView2 deadlock).
    std::thread::spawn(move || {
        if !crate::engine::open_review_popup(&app) {
            log::error!("[review] failed to open popup window after start_new_review");
        }
    });
    Ok(n)
}

/// 组卷: compose a custom session from deck quotas (+ today's due cards),
/// load it into the explicit-session slot and open the popup.
#[tauri::command]
pub fn compose_exam(
    parts: Vec<services::ExamPart>,
    include_due: bool,
    strategy: services::ExamStrategy,
    session: SessionState,
    db: DbState,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let n = services::compose_exam(&lock(&db), &session, &parts, include_due, strategy)?;
    std::thread::spawn(move || {
        if !crate::engine::open_review_popup(&app) {
            log::error!("[review] failed to open popup window after compose_exam");
        }
    });
    Ok(n)
}

#[tauri::command]
pub fn save_exam_preset(name: String, config_json: String, db: DbState) -> Result<i64, String> {
    services::save_exam_preset(&lock(&db), &name, &config_json)
}

#[tauri::command]
pub fn list_exam_presets(db: DbState) -> Result<Vec<(i64, String, String)>, String> {
    services::list_exam_presets(&lock(&db))
}

#[tauri::command]
pub fn delete_exam_preset(id: i64, db: DbState) -> Result<bool, String> {
    services::delete_exam_preset(&lock(&db), id)
}

/// Frontend reports how a popup session ended (close policy): reason
/// "completed" | "closed"; unknown-by-absence never counts as a dodge.
#[tauri::command]
pub fn report_popup_session(
    session_id: i64,
    reason: String,
    shown: Option<i64>,
    rated: Option<i64>,
    db: DbState,
) -> Result<(), String> {
    services::report_popup_session(&lock(&db), session_id, &reason, shown, rated)
}

/// Close-policy context for the popup UI (strict flag + current dodge streak).
#[tauri::command]
pub fn close_context(db: DbState) -> Result<services::CloseContext, String> {
    services::close_context(&lock(&db))
}

/// 弹窗内的交互心跳（离手逃离用，SPEC §8.4）：揭示答案、评分、跳过、编辑、
/// 按键都会由前端**节流**上报一次，引擎据此判断"人还在不在"。纯内存原子写，
/// 不落库、不返回东西——这里只做一次 store，调用方不需要等结果。
#[tauri::command]
pub fn popup_activity(app: tauri::AppHandle) {
    crate::engine::mark_popup_activity(&app);
}

/// Explicit home-page trigger. Running the native window operation off the
/// invoke callback avoids the WebView2 UI-thread deadlock on Windows.
#[tauri::command]
pub async fn open_review_now(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if crate::engine::open_review_popup(&app) {
            Ok(())
        } else {
            // Also logged: the frontend surfaces the failure, but the reason
            // belongs in the log file for the bug report.
            let msg = "复习弹窗打开失败";
            log::error!("[review] open_review_now failed (popup missing or show error)");
            Err(msg.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn search_cards(
    query: Option<String>,
    deck: Option<String>,
    filter: Option<String>,
    db: DbState,
) -> Result<Vec<CardDto>, String> {
    services::search_cards(&lock(&db), query, deck, filter)
}

#[tauri::command]
pub fn get_card(card_id: i64, db: DbState) -> Result<CardDto, String> {
    services::card(&lock(&db), card_id)
}

/// Jump-to-editor from the popup's 知识铺垫 (SPEC §11.2): focus the main window
/// and tell it which card to open, while the popup yields (hides) so the
/// editor is unobstructed. The main window's close handler restores the popup.
#[tauri::command]
pub fn edit_card_in_main(card_id: i64, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    if let Some(state) = app.try_state::<crate::PopupResumeState>() {
        *state.0.lock().map_err(|_| "popup 状态锁失败".to_string())? = true;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    if let Some(popup) = app.get_webview_window("popup") {
        let _ = popup.hide();
    }
    app.emit("edit-card", card_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_markdown(
    files: Vec<ImportFile>,
    prefer_file: bool,
    db: DbState,
) -> Result<ImportReport, String> {
    services::import_markdown(&lock(&db), &files, prefer_file)
}

#[tauri::command]
pub fn preview_import(files: Vec<ImportFile>, db: DbState) -> Result<ImportPreview, String> {
    services::preview_import(&lock(&db), &files)
}

/// First-run onboarding: import the bundled sample deck (idempotent).
#[tauri::command]
pub fn import_sample_deck(db: DbState) -> Result<ImportReport, String> {
    services::import_sample_deck(&lock(&db))
}

/// Markdown 导出：`deck = None` 导出全部卡包。路径由前端保存对话框提供。
#[tauri::command]
pub fn export_markdown(
    path: String,
    deck: Option<String>,
    db: DbState,
) -> Result<ExportReport, String> {
    services::export_markdown(&lock(&db), &path, deck.as_deref())
}

/// `front_md` is the optional 题面 (SPEC §5.2 rule 10, 需求7); omitting it keeps
/// the pre-需求7 call shape and creates a plain card.
#[tauri::command]
pub fn add_card(
    deck: String,
    chapter: String,
    title: String,
    content_md: String,
    front_md: Option<String>,
    db: DbState,
) -> Result<CardDto, String> {
    services::add_card_with_front(
        &lock(&db),
        &deck,
        &chapter,
        &title,
        &content_md,
        front_md.as_deref().unwrap_or(""),
    )
}

#[tauri::command]
pub fn list_overview(db: DbState) -> Result<Vec<DeckOverview>, String> {
    services::list_overview(&lock(&db))
}

#[tauri::command]
pub fn list_cards(deck: String, db: DbState) -> Result<Vec<CardDto>, String> {
    services::list_cards(&lock(&db), &deck)
}

#[tauri::command]
pub fn rename_deck(old_name: String, new_name: String, db: DbState) -> Result<(), String> {
    services::rename_deck(&lock(&db), &old_name, &new_name)
}

#[tauri::command]
pub fn delete_deck(name: String, db: DbState) -> Result<(), String> {
    services::delete_deck(&mut lock(&db), &name)
}

#[tauri::command]
pub fn delete_card(card_id: i64, db: DbState) -> Result<(), String> {
    services::delete_card(&lock(&db), card_id)
}

/// `front_md`: `None` (or an omitted argument) leaves the 题面 untouched — the
/// card editor only sends it when it actually edits the front (需求7).
#[tauri::command]
pub fn update_card(
    card_id: i64,
    title: String,
    content_md: String,
    front_md: Option<String>,
    db: DbState,
) -> Result<CardDto, String> {
    services::update_card_with_front(
        &lock(&db),
        card_id,
        &title,
        &content_md,
        front_md.as_deref(),
    )
}

#[tauri::command]
pub fn save_card_content(card_id: i64, content_md: String, db: DbState) -> Result<CardDto, String> {
    services::update_card_content(&lock(&db), card_id, &content_md)
}

#[tauri::command]
pub fn due_queue(limit: i64, db: DbState) -> Result<Vec<CardDto>, String> {
    // The roll drives the 15% 归档抽查 slot; nanos give a fresh draw per call.
    let roll = f64::from(chrono::Utc::now().timestamp_subsec_nanos()) / 1e9;
    services::due_queue(&lock(&db), limit, roll)
}

#[tauri::command]
pub fn rate_card(
    card_id: i64,
    rating: String,
    elapsed_ms: Option<i64>,
    app: tauri::AppHandle,
    db: DbState,
) -> Result<CardDto, String> {
    crate::logging::breadcrumb("cmd:rate-in");
    let dto = services::rate(&mut lock(&db), card_id, &rating, elapsed_ms);
    crate::logging::breadcrumb("cmd:rate-out");
    // Wake the engine: the queue shape changed.
    crate::engine::notify(&app, crate::engine::EngineEvent::ReviewActivity);
    dto
}

#[tauri::command]
pub fn skip_card(card_id: i64, app: tauri::AppHandle, db: DbState) -> Result<CardDto, String> {
    let dto = services::skip_card(&lock(&db), card_id);
    crate::engine::notify(&app, crate::engine::EngineEvent::ReviewActivity);
    dto
}

#[tauri::command]
pub fn preview_intervals(card_id: i64, db: DbState) -> Result<Vec<u64>, String> {
    services::preview_intervals(&lock(&db), card_id)
}

#[tauri::command]
pub fn mark_card_shown(card_id: i64, db: DbState) -> Result<(), String> {
    services::mark_shown(&lock(&db), card_id)
}

#[tauri::command]
pub fn due_count(db: DbState) -> Result<i64, String> {
    services::due_count(&lock(&db))
}

#[tauri::command]
pub fn goal_status(db: DbState) -> Result<services::GoalStatus, String> {
    services::goal_status(&lock(&db))
}

/// 屏幕监控实时状态（设置页「实时捕捉」面板）：上一次采样看到的进程/标题/
/// 命中规则——纯内存读取，不落库不写日志。
#[tauri::command]
pub fn activity_status(app: tauri::AppHandle) -> Result<crate::activity::ActivityStatus, String> {
    app.try_state::<std::sync::Arc<crate::activity::ActivityShared>>()
        .map(|s| s.status())
        .ok_or_else(|| "activity monitor not started".into())
}

#[tauri::command]
pub fn get_stats(db: DbState) -> Result<services::StatsDto, String> {
    crate::logging::breadcrumb("cmd:get-stats-in");
    let r = services::get_stats(&lock(&db));
    crate::logging::breadcrumb("cmd:get-stats-out");
    r
}

#[tauri::command]
pub fn list_attention_cards(db: DbState) -> Result<Vec<CardDto>, String> {
    services::attention_cards(&lock(&db))
}

#[tauri::command]
pub fn clear_attention(card_id: i64, db: DbState) -> Result<CardDto, String> {
    services::clear_attention(&lock(&db), card_id)
}

#[tauri::command]
pub fn reset_card_progress(card_id: i64, db: DbState) -> Result<CardDto, String> {
    services::reset_progress(&lock(&db), card_id)
}

#[tauri::command]
pub fn restore_card(card_id: i64, db: DbState) -> Result<CardDto, String> {
    services::restore_card(&lock(&db), card_id)
}

/// Manual backup (SPEC §14/F18): snapshot the DB and return the file path.
#[tauri::command]
pub fn backup_now(db: DbState) -> Result<String, String> {
    let appdata = std::env::var("APPDATA").map_err(|e| e.to_string())?;
    services::backup_now(
        &lock(&db),
        &std::path::Path::new(&appdata).join("FlashMemo"),
    )
}

#[tauri::command]
pub fn get_card_context(card_id: i64, db: DbState) -> Result<services::CardContextDto, String> {
    services::card_context(&lock(&db), card_id)
}

#[tauri::command]
pub fn get_card_links(card_id: i64, db: DbState) -> Result<services::CardLinksDto, String> {
    services::card_links(&lock(&db), card_id)
}

#[tauri::command]
pub fn add_card_link(from_id: i64, to_id: i64, db: DbState) -> Result<(), String> {
    services::add_card_link(&lock(&db), from_id, to_id)
}

#[tauri::command]
pub fn remove_card_link(from_id: i64, to_id: i64, db: DbState) -> Result<(), String> {
    services::remove_card_link(&lock(&db), from_id, to_id)
}

#[tauri::command]
pub fn set_deck_chain(deck: String, enabled: bool, db: DbState) -> Result<(), String> {
    services::set_deck_chain(&lock(&db), &deck, enabled)
}

#[tauri::command]
pub fn get_settings(db: DbState) -> Result<HashMap<String, String>, String> {
    Ok(services::list_settings(&lock(&db))?.into_iter().collect())
}

#[tauri::command]
pub fn set_settings(
    map: HashMap<String, String>,
    app: tauri::AppHandle,
    db: DbState,
) -> Result<(), String> {
    crate::logging::breadcrumb("cmd:set-settings-in");
    services::set_settings(&lock(&db), &map.into_iter().collect::<Vec<_>>())?;
    crate::logging::breadcrumb("cmd:set-settings-db-done");
    // Drop the engine's cached settings so the change lands on the next wake.
    crate::engine::notify(&app, crate::engine::EngineEvent::SettingsChanged);
    Ok(())
}

// ---------------------------------------------------------------- 图片附件
// SPEC §5.4: card images live in %APPDATA%\FlashMemo\attachments and the card
// markdown only stores an `attachment:<file>` reference.

/// Folder the frontend resolves `attachment:` refs against (asset protocol).
#[tauri::command]
pub fn attachment_dir() -> Result<String, String> {
    let dir = crate::attachments::store_dir()?;
    // Forward slashes: the path goes into a URL, and Windows accepts both.
    Ok(dir.to_string_lossy().replace('\\', "/"))
}

/// Store a picked image file (native dialog path) and return its markdown ref.
#[tauri::command]
pub fn save_attachment_file(path: String) -> Result<String, String> {
    let dir = crate::attachments::store_dir()?;
    crate::attachments::save_file(&dir, std::path::Path::new(&path))
}

/// Store pasted/clipboard image bytes (`data:` URL) and return the markdown ref.
#[tauri::command]
pub fn save_attachment(data: String, ext: Option<String>) -> Result<String, String> {
    let dir = crate::attachments::store_dir()?;
    let (bytes, mime) = crate::attachments::parse_data_url(&data)?;
    crate::attachments::save_bytes(&dir, &bytes, ext.as_deref().or(mime.as_deref()))
}

/// Read picked `.md` files (native dialog gives paths, not contents) so the
/// import can resolve image refs relative to each file's folder.
#[tauri::command]
pub fn read_markdown_files(paths: Vec<String>) -> Result<Vec<ImportFile>, String> {
    services::read_markdown_files(&paths)
}

/// 开机自启当前状态（读系统启动项，不是 KV——用户可能在任务管理器里改过）。
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("读取开机自启状态失败: {e}"))
}

/// 即时切换（不等「保存设置」：这是系统级开关，落库只会造成两套真相）。
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch
            .enable()
            .map_err(|e| format!("开启开机自启失败: {e}"))?;
    } else {
        autolaunch
            .disable()
            .map_err(|e| format!("关闭开机自启失败: {e}"))?;
    }
    autolaunch
        .is_enabled()
        .map_err(|e| format!("读取开机自启状态失败: {e}"))
}
