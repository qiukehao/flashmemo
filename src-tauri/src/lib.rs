pub mod commands;
pub mod db;
pub mod import;
pub mod parser;
pub mod scheduler;
pub mod services;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // SPEC §14: data lives in %APPDATA%\FlashMemo.
            let appdata =
                std::env::var("APPDATA").map_err(|e| format!("APPDATA unavailable: {e}"))?;
            let db_path = std::path::Path::new(&appdata)
                .join("FlashMemo")
                .join("data.db");
            let database = db::Db::open(&db_path).map_err(|e| e.to_string())?;
            app.manage(Mutex::new(database));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_markdown,
            commands::preview_import,
            commands::add_card,
            commands::list_overview,
            commands::due_queue,
            commands::rate_card,
            commands::skip_card,
            commands::preview_intervals,
            commands::due_count,
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
