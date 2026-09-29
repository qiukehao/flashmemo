pub mod ai;
pub mod commands;
pub mod db;
pub mod engine;
pub mod import;
pub mod parser;
pub mod scheduler;
pub mod services;

use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

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
    let db = state.lock().expect("db mutex poisoned");
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // SPEC §14: data lives in %APPDATA%\FlashMemo.
            let appdata =
                std::env::var("APPDATA").map_err(|e| format!("APPDATA unavailable: {e}"))?;
            let db_path = std::path::Path::new(&appdata)
                .join("FlashMemo")
                .join("data.db");
            let database = db::Db::open(&db_path).map_err(|e| e.to_string())?;
            // SPEC §14/F18: daily first-launch backup (best effort — a backup
            // failure must never block startup).
            if let Err(e) =
                services::daily_backup(&database, &std::path::Path::new(&appdata).join("FlashMemo"))
            {
                eprintln!("[backup] daily backup failed: {e}");
            }
            app.manage(Mutex::new(database));
            // Manual review selections ("复习选中/复习该包") wait here for the popup.
            app.manage(services::ReviewSession::default());

            // SPEC §8.2: 15s tick engine + tray "立即复习" fast path.
            let engine_state =
                std::sync::Arc::new(std::sync::Mutex::new(engine::EngineState::default()));
            engine::spawn(app.handle().clone(), engine_state.clone());
            engine::listen_force_review(app.handle(), engine_state);

            // SPEC §13: tray menu.
            let review_now = MenuItem::with_id(app, "review_now", "立即复习", true, None::<&str>)?;
            let pause_1h =
                MenuItem::with_id(app, "pause_1h", "暂停提醒 1 小时", true, None::<&str>)?;
            let pause_today =
                MenuItem::with_id(app, "pause_today", "暂停今日提醒", true, None::<&str>)?;
            let open_panel = MenuItem::with_id(app, "open", "打开管理面板", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&review_now, &pause_1h, &pause_today, &open_panel, &quit],
            )?;
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
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
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
            commands::start_review,
            commands::review_queue,
            commands::due_queue,
            commands::rate_card,
            commands::skip_card,
            commands::preview_intervals,
            commands::mark_card_shown,
            commands::due_count,
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
            ai::ai_sidebar_open,
            ai::ai_sidebar_resize,
            ai::ai_sidebar_close,
            ai::show_main_with_ai,
            commands::get_settings,
            commands::set_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        assert_eq!(2 + 2, 4);
    }
}
