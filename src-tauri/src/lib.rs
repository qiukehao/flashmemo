pub mod activity;
pub mod ai;
pub mod attachments;
pub mod commands;
pub mod db;
pub mod engine;
pub mod goal;
pub mod import;
pub mod logging;
pub mod parser;
pub mod scheduler;
pub mod services;

use std::sync::{Mutex, PoisonError};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

/// Lock recovery shared by every mutex site: a poisoned lock means a thread
/// panicked while holding it (already captured by the panic hook); the data
/// underneath is still usable, and a dead engine/command layer is worse than
/// continuing. Every recovery is logged for the bug report.
pub fn recover_lock<T>(poisoned: PoisonError<T>) -> T {
    log::warn!("recovered from a poisoned mutex: {poisoned}");
    poisoned.into_inner()
}

/// Tracks whether the popup was deliberately hidden while the user edits a
/// prerequisite card in the main window. A normal main-window close must not
/// surface the pre-created hidden popup.
#[derive(Default)]
pub struct PopupResumeState(pub Mutex<bool>);

/// Bring the existing main window to the front (single-instance re-launch and
/// tray menu share this).
fn show_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn set_paused_until<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    until: chrono::DateTime<chrono::Utc>,
) {
    let state = app.state::<Mutex<db::Db>>();
    let db = state.lock().unwrap_or_else(recover_lock);
    let _ = db.set_setting("paused_until", &db::fmt_time(until));
}

fn pause_until_local(hour: u32, minute: u32) -> chrono::DateTime<chrono::Utc> {
    let naive = chrono::Local::now()
        .date_naive()
        .and_hms_opt(hour, minute, 0)
        .expect("valid time");
    naive
        .and_local_timezone(chrono::Local)
        .single()
        .expect("local time resolves")
        .with_timezone(&chrono::Utc)
}

/// 托盘「加入监控清单」：把当前采样的程序/窗口标题写进规则 KV，通知反馈结果。
/// 规则生效在下一个采样（≤3s），托盘信息行会随之变成「命中「xxx」」。
fn handle_tray_add(app: &tauri::AppHandle, id: &str) {
    use tauri_plugin_notification::NotificationExt;
    let show = |body: String| {
        let _ = app
            .notification()
            .builder()
            .title("闪记 FlashMemo")
            .body(body)
            .show();
    };
    let Some(shared) = app.try_state::<std::sync::Arc<activity::ActivityShared>>() else {
        return;
    };
    let status = shared.status();
    let (kind, category, label) = match id {
        "add_ent_exe" => ("exe", "entertainment", "娱乐"),
        "add_ent_title" => ("title", "entertainment", "娱乐"),
        "add_study_exe" => ("exe", "study", "学习"),
        _ => ("title", "study", "学习"),
    };
    // 窗口标题取前 40 字作关键词起点（页面标题常变，精确关键词在设置里改）。
    let pattern: String = if kind == "exe" {
        status.process.clone()
    } else {
        status.title.chars().take(40).collect()
    };
    if pattern.trim().is_empty() {
        show("当前没有可加入的程序（空闲或监控未开启）".into());
        return;
    }
    let rule = activity::ActivityRule {
        kind: kind.into(),
        pattern: pattern.clone(),
        category: category.into(),
    };
    let outcome = app.try_state::<Mutex<db::Db>>().and_then(|cell| {
        let db = cell.lock().ok()?;
        activity::add_rule_to_settings(&db, rule).ok()
    });
    match outcome {
        Some(true) => show(format!(
            "已加入{label}清单：{pattern}\n（最多 3 秒后生效，托盘会显示「命中」）"
        )),
        Some(false) => show(format!("{label}清单里已有：{pattern}")),
        None => show("加入清单失败，请到设置里手动添加".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First thing: file logging + panic capture, so anything after this line
    // (including startup panics) lands in %APPDATA%\FlashMemo\logs.
    logging::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // SPEC §14: data lives in %APPDATA%\FlashMemo.
            let appdata =
                std::env::var("APPDATA").map_err(|e| format!("APPDATA unavailable: {e}"))?;
            let db_path = std::path::Path::new(&appdata)
                .join("FlashMemo")
                .join("data.db");
            let database = db::Db::open(&db_path).map_err(|e| e.to_string())?;
            // SPEC §5.4: allow the asset protocol to serve card images from the
            // attachment folder only (the config scope stays empty on purpose).
            match attachments::store_dir() {
                Ok(dir) => {
                    let _ = std::fs::create_dir_all(&dir);
                    app.asset_protocol_scope()
                        .allow_directory(&dir, true)
                        .map_err(|e| format!("asset scope: {e}"))?;
                }
                Err(e) => log::warn!("[attachments] {e}; card images will not render"),
            }
            // SPEC §14/F18: daily first-launch backup (best effort — a backup
            // failure must never block startup).
            if let Err(e) =
                services::daily_backup(&database, &std::path::Path::new(&appdata).join("FlashMemo"))
            {
                log::warn!("[backup] daily backup failed: {e}");
            }
            // 诊断面包屑默认关闭（保持日志干净）；排障时用设置项打开。
            if database
                .get_setting("debug_breadcrumbs")
                .ok()
                .flatten()
                .is_some_and(|v| v.trim() == "1")
            {
                logging::set_breadcrumbs(true);
                log::info!("[logging] diagnostic breadcrumbs enabled via settings");
            }
            app.manage(Mutex::new(database));
            // Manual review selections ("复习选中/复习该包") wait here for the popup.
            app.manage(services::ReviewSession::default());
            app.manage(PopupResumeState::default());

            // The popup WebView is pre-created hidden. Keep startup robust if
            // the platform restores the configured window as visible.
            if let Some(popup) = app.get_webview_window("popup") {
                let _ = popup.hide();
                // Belt-and-braces over tauri.conf.json: a skip-taskbar window
                // that gets minimized becomes unreachable (user report
                // 2026-10-05), so the buttons never exist in the first place.
                let _ = popup.set_minimizable(false);
                let _ = popup.set_maximizable(false);
            }

            // SPEC §8.2: 15s tick engine + tray "立即复习" fast path.
            let engine_state =
                std::sync::Arc::new(std::sync::Mutex::new(engine::EngineState::default()));
            app.manage(engine::EngineShared::default());
            engine::spawn(app.handle().clone(), engine_state.clone());
            engine::listen_force_review(app.handle(), engine_state);
            // AI 助手窗口的停靠看护：跟随所属窗口移动/隐藏（SPEC §10）。
            app.manage(ai::AiDock::default());
            ai::spawn_dock_watcher(app.handle().clone());
            // 屏幕监控 (2026-10-04, 娱乐加速): shared state + watcher thread.
            app.manage(std::sync::Arc::new(
                crate::activity::ActivityShared::default(),
            ));
            crate::activity::spawn_monitor(app.handle().clone());

            // SPEC §13: tray menu.
            let review_now = MenuItem::with_id(app, "review_now", "立即复习", true, None::<&str>)?;
            let pause_1h =
                MenuItem::with_id(app, "pause_1h", "暂停提醒 1 小时", true, None::<&str>)?;
            let pause_today =
                MenuItem::with_id(app, "pause_today", "暂停今日提醒", true, None::<&str>)?;
            // 监控信息区：文本由采样线程刷新（右键即可看到监控正在看什么，
            // 规则才能写得准），「加入监控清单」直接把当前程序/标题入清单。
            let mon_line1 =
                MenuItem::with_id(app, "activity_line1", "屏幕监控未开启", false, None::<&str>)?;
            let mon_line2 = MenuItem::with_id(app, "activity_line2", "", false, None::<&str>)?;
            let add_exe_ent =
                MenuItem::with_id(app, "add_ent_exe", "娱乐 · 当前程序", true, None::<&str>)?;
            let add_title_ent = MenuItem::with_id(
                app,
                "add_ent_title",
                "娱乐 · 当前窗口标题",
                true,
                None::<&str>,
            )?;
            let add_exe_study =
                MenuItem::with_id(app, "add_study_exe", "学习 · 当前程序", true, None::<&str>)?;
            let add_title_study = MenuItem::with_id(
                app,
                "add_study_title",
                "学习 · 当前窗口标题",
                true,
                None::<&str>,
            )?;
            let add_menu = tauri::menu::Submenu::with_items(
                app,
                "加入监控清单",
                true,
                &[
                    &add_exe_ent,
                    &add_title_ent,
                    &add_exe_study,
                    &add_title_study,
                ],
            )?;
            let open_activity =
                MenuItem::with_id(app, "open_activity", "打开监控设置", true, None::<&str>)?;
            let open_panel = MenuItem::with_id(app, "open", "打开管理面板", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep1 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let sep2 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &review_now,
                    &pause_1h,
                    &pause_today,
                    &sep1,
                    &mon_line1,
                    &mon_line2,
                    &add_menu,
                    &open_activity,
                    &sep2,
                    &open_panel,
                    &quit,
                ],
            )?;
            app.manage(activity::TrayMonitor::new(
                mon_line1,
                mon_line2,
                add_exe_ent,
                add_title_ent,
                add_exe_study,
                add_title_study,
            ));
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .tooltip("闪记 FlashMemo")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "review_now" => {
                        let _ = app.emit("force-review", ());
                    }
                    "pause_1h" => {
                        set_paused_until(app, chrono::Utc::now() + chrono::Duration::hours(1));
                    }
                    "pause_today" => set_paused_until(app, pause_until_local(23, 59)),
                    "open" => show_main(app),
                    "open_activity" => {
                        show_main(app);
                        let _ = app.emit("open-activity-settings", ());
                    }
                    "add_ent_exe" | "add_ent_title" | "add_study_exe" | "add_study_title" => {
                        handle_tray_add(app, event.id.as_ref());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // SPEC §13: closing the main window hides to tray, only the tray
            // menu "退出" ends the process.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    // A popup hidden by jump-to-edit (§11.2) resumes once the
                    // user is done with the main window.
                    let resume_popup = window
                        .app_handle()
                        .try_state::<PopupResumeState>()
                        .and_then(|state| {
                            state
                                .0
                                .lock()
                                .ok()
                                .map(|mut flag| std::mem::take(&mut *flag))
                        })
                        .unwrap_or(false);
                    if resume_popup {
                        if let Some(popup) = window.app_handle().get_webview_window("popup") {
                            if !popup.is_visible().unwrap_or(true) {
                                let _ = popup.show();
                                let _ = popup.unminimize();
                                let _ = popup.set_focus();
                            }
                        }
                    }
                } else if window.label() == "ai" {
                    // The AI window HIDES on close instead of dying: the site
                    // page (with the user's conversation) must survive so the
                    // next open continues the same chat (2026-10-07 feedback).
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label() == "popup" {
                    // Keep the pre-created popup WebView alive. Closing it
                    // would destroy the second WebView2 controller, bringing
                    // back the Windows deadlock the hidden-window setup avoids.
                    api.prevent_close();
                    // 无法关闭模式 (2026-10-04 close policy): in strict mode the
                    // popup refuses to even hide — the session ends only by
                    // rating every card. The tray "暂停提醒" remains the
                    // sanctioned escape for emergencies.
                    let strict = window
                        .app_handle()
                        .try_state::<Mutex<crate::db::Db>>()
                        .and_then(|cell| {
                            let db = cell.lock().ok()?;
                            Some(services::close_policy_strict(&db))
                        })
                        .unwrap_or(false);
                    if strict {
                        log::info!("[review] strict mode: popup close request ignored");
                    } else {
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::frontend_log,
            commands::import_markdown,
            commands::preview_import,
            commands::add_card,
            commands::list_overview,
            commands::list_cards,
            commands::rename_deck,
            commands::delete_deck,
            commands::delete_card,
            commands::update_card,
            commands::save_card_content,
            commands::search_cards,
            commands::get_card,
            commands::edit_card_in_main,
            commands::start_review,
            commands::start_new_review,
            commands::compose_exam,
            commands::save_exam_preset,
            commands::list_exam_presets,
            commands::delete_exam_preset,
            commands::report_popup_session,
            commands::close_context,
            commands::popup_activity,
            commands::open_review_now,
            commands::review_queue,
            commands::due_queue,
            commands::rate_card,
            commands::skip_card,
            commands::preview_intervals,
            commands::mark_card_shown,
            commands::due_count,
            commands::goal_status,
            commands::activity_status,
            commands::get_stats,
            commands::list_attention_cards,
            commands::clear_attention,
            commands::reset_card_progress,
            commands::restore_card,
            commands::backup_now,
            commands::get_card_context,
            commands::get_card_links,
            commands::add_card_link,
            commands::remove_card_link,
            commands::set_deck_chain,
            ai::ai_window_show,
            ai::ai_window_attach,
            ai::ai_window_resize,
            ai::ai_window_hide,
            ai::show_main_with_ai,
            ai::ai_fill_question,
            commands::get_settings,
            commands::set_settings,
            commands::attachment_dir,
            commands::save_attachment,
            commands::save_attachment_file,
            commands::read_markdown_files,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_handle, event| {
            // Clean-exit breadcrumb (2026-10-05): two silent process deaths
            // left no panic and no OS crash record. With this line, a log that
            // stops WITHOUT it proves the process was terminated externally
            // (terminal closed, taskkill, firmware hang) rather than exiting
            // through Tauri's own teardown.
            if let tauri::RunEvent::Exit = event {
                log::info!("[app] event loop exited (clean shutdown path)");
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        assert_eq!(2 + 2, 4);
    }
}
