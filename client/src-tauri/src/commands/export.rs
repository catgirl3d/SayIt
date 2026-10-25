use serde::Deserialize;
use std::fs;
use std::io::Write;
use tauri::Emitter;

#[derive(Deserialize)]
pub struct TextExportPayload {
    #[serde(rename = "defaultPath")]
    pub default_path: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct ExportFile {
    pub name: String,
    pub content: String,
}

/// Export writes caller-provided content to a caller-provided path, so the
/// extension is pinned to the formats this command actually produces. That
/// keeps the command from becoming a way to place .bat/.exe/.ps1 files.
fn check_export_extension(path: &std::path::Path, allowed: &[&str]) -> Result<(), String> {
    if crate::path_guard::has_extension(path, allowed) {
        Ok(())
    } else {
        Err(format!(
            "Export file must end with .{}",
            allowed.join(" / .")
        ))
    }
}

#[tauri::command]
pub fn save_text_export(payload: TextExportPayload) -> Result<Option<String>, String> {
    let path = std::path::PathBuf::from(&payload.default_path);
    check_export_extension(&path, &["json", "csv"])?;
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, &payload.content).map_err(|e| e.to_string())?;
    let abs = fs::canonicalize(&path).unwrap_or(path);
    let abs_str = abs.to_string_lossy().to_string();
    let clean = abs_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&abs_str)
        .to_string();
    Ok(Some(clean))
}

/// 完整导出：JSON 文件 + 音频目录，带进度事件
#[derive(Deserialize)]
pub struct FullExportPayload {
    #[serde(rename = "defaultPath")]
    pub default_path: String,
    pub files: Vec<ExportFile>,
}

#[derive(serde::Serialize, Clone)]
struct ExportProgress {
    current: usize,
    total: usize,
    filename: String,
}

#[tauri::command]
pub async fn save_full_export(
    app: tauri::AppHandle,
    payload: FullExportPayload,
) -> Result<Option<String>, String> {
    let out_path = std::path::PathBuf::from(&payload.default_path);
    check_export_extension(&out_path, &["zip"])?;
    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // 收集音频文件列表
    let audio_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("audio");

    let mut audio_files: Vec<std::path::PathBuf> = Vec::new();
    if audio_dir.exists() {
        if let Ok(entries) = fs::read_dir(&audio_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    audio_files.push(p);
                }
            }
        }
    }

    let total = payload.files.len() + audio_files.len();
    let json_files = payload.files;
    let app_handle = app.clone();

    // 在阻塞线程中执行 zip 打包
    tokio::task::spawn_blocking(move || {
        let file = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let text_opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let audio_opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored); // 音频不压缩，速度快

        let mut current = 0usize;

        // 写入 JSON 文件
        for item in &json_files {
            current += 1;
            let _ = app_handle.emit(
                "export-progress",
                ExportProgress {
                    current,
                    total,
                    filename: item.name.clone(),
                },
            );
            zip.start_file(&item.name, text_opts)
                .map_err(|e| e.to_string())?;
            zip.write_all(item.content.as_bytes())
                .map_err(|e| e.to_string())?;
        }

        // 写入音频文件
        for audio_path in &audio_files {
            current += 1;
            let fname = audio_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".into());
            let _ = app_handle.emit(
                "export-progress",
                ExportProgress {
                    current,
                    total,
                    filename: fname.clone(),
                },
            );
            let zip_name = format!("audio/{}", fname);
            zip.start_file(&zip_name, audio_opts)
                .map_err(|e| e.to_string())?;
            let bytes = fs::read(audio_path)
                .map_err(|e| format!("Failed to read audio file {}: {}", fname, e))?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }

        zip.finish().map_err(|e| e.to_string())?;
        let abs = fs::canonicalize(&out_path).unwrap_or(out_path);
        let abs_str = abs.to_string_lossy().to_string();
        let clean = abs_str
            .strip_prefix(r"\\?\")
            .unwrap_or(&abs_str)
            .to_string();
        Ok(Some(clean))
    })
    .await
    .map_err(|e| format!("Export task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("sayit-export-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn text_export_rejects_an_executable_extension_before_touching_the_filesystem() {
        let root = temp_root();
        let path = root.join("evil.bat");

        let result = save_text_export(TextExportPayload {
            default_path: path.to_string_lossy().to_string(),
            content: "@echo off\r\ncalc\r\n".to_string(),
        });
        let created = root.exists();

        let _ = std::fs::remove_dir_all(&root);

        assert!(
            result.is_err(),
            "an executable export extension must be rejected"
        );
        assert!(
            !created,
            "the export created directories before rejecting the extension"
        );
    }

    #[test]
    fn text_export_still_writes_supported_formats() {
        let root = temp_root();
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("history.json");

        let result = save_text_export(TextExportPayload {
            default_path: path.to_string_lossy().to_string(),
            content: "{\"ok\":true}".to_string(),
        });
        let content = std::fs::read_to_string(&path).unwrap();

        let _ = std::fs::remove_dir_all(&root);

        assert!(result.unwrap().is_some());
        assert_eq!(content, "{\"ok\":true}");
    }
}
