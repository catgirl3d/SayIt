use crate::storage::Storage;
use serde::Serialize;
use serde_json::Value;
use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use tauri::{AppHandle, State};

/// Persistent log file writer — opened once, reused across calls.
static LOG_FILE: std::sync::LazyLock<Mutex<Option<std::fs::File>>> =
    std::sync::LazyLock::new(|| {
        let file = open_log_file();
        Mutex::new(file)
    });

/// Max log file size before rotation (5 MB)
const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024;
/// Number of rotated files to keep
const ROTATED_FILES_KEEP: usize = 3;

#[cfg(not(test))]
fn log_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("logs")
}

#[cfg(test)]
fn log_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("sayit-test-logs-{}", std::process::id()))
}

fn log_file_path() -> std::path::PathBuf {
    log_dir().join("sayit.log")
}

fn open_log_file() -> Option<std::fs::File> {
    let dir = log_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[log] failed to create log dir {:?}: {}", dir, e);
        return None;
    }
    let path = log_file_path();
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
}

fn rotate_if_needed(file: &mut Option<std::fs::File>) {
    let path = log_file_path();
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size < MAX_LOG_SIZE {
        return;
    }

    // Windows 不允许重命名仍由本进程打开的日志文件。先释放句柄，否则轮转会
    // 静默失败，正式版长期运行后 sayit.log 会无限增长。
    *file = None;

    // Rotate: sayit.log -> sayit.1.log, sayit.1.log -> sayit.2.log, etc.
    let dir = log_dir();
    for i in (1..ROTATED_FILES_KEEP).rev() {
        let from = dir.join(format!("sayit.{}.log", i));
        let to = dir.join(format!("sayit.{}.log", i + 1));
        let _ = std::fs::rename(&from, &to);
    }
    let rotated = dir.join("sayit.1.log");
    let _ = std::fs::rename(&path, &rotated);
    *file = open_log_file();
}

pub fn write_log_line(line: &str) {
    // 用 unwrap_or_else 而非 unwrap()：即使这个 Mutex 曾在某次 panic 中被"污染"
    // （poisoned），日志功能也不能跟着永久失效——否则会形成"一次意外 panic 导致
    // 之后所有诊断日志都写不出来"的雪崩，恰恰是排查间歇性问题最怕遇到的情况。
    let mut guard = LOG_FILE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Rotate check — reopen file if needed
    rotate_if_needed(&mut guard);
    if guard.is_none() {
        *guard = open_log_file();
    }
    if let Some(ref mut f) = *guard {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "[{}] {}", ts, line);
        let _ = f.flush();
    }
}

fn get_os_version() -> String {
    #[cfg(target_os = "windows")]
    {
        // 从注册表读取，不弹窗口
        use std::process::Command;
        Command::new("cmd")
            .args(["/C", "ver"])
            .creation_flags(0x08000000)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s: String| s.trim().to_string())
            .unwrap_or_else(|| "Windows".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        whoami::distro()
    }
}

fn get_local_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

fn get_system_locale() -> String {
    // 用原生 Win32 API 取区域设置，避免拉起 PowerShell（冷启动 1-2 秒）。
    // GetUserDefaultLocaleName 返回形如 "zh-CN" 的 BCP-47 名称，与原 (Get-Culture).Name 一致。
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Globalization::GetUserDefaultLocaleName;
        // LOCALE_NAME_MAX_LENGTH = 85
        let mut buf = [0u16; 85];
        let len = unsafe { GetUserDefaultLocaleName(&mut buf) };
        if len > 1 {
            // 返回值含结尾的 NUL，切掉它。
            String::from_utf16_lossy(&buf[..(len as usize - 1)])
        } else {
            "unknown".to_string()
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("LANG").unwrap_or_else(|_| "unknown".to_string())
    }
}

fn get_total_memory_mb() -> u64 {
    // 用原生 GlobalMemoryStatusEx 取物理内存，避免拉起 PowerShell。
    // ullTotalPhys 为字节，/ 1MB 与原 TotalPhysicalMemory / 1MB 语义一致。
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if unsafe { GlobalMemoryStatusEx(&mut status) }.is_ok() {
            status.ullTotalPhys / (1024 * 1024)
        } else {
            0
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        0
    }
}

#[derive(Serialize)]
pub struct ClientRuntimeInfo {
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(rename = "userName")]
    pub user_name: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub hostname: String,
    #[serde(rename = "clientVersion")]
    pub client_version: String,
    pub platform: String,
    #[serde(rename = "osVersion")]
    pub os_version: String,
    #[serde(rename = "localIp")]
    pub local_ip: String,
    #[serde(rename = "systemLocale")]
    pub system_locale: String,
    #[serde(rename = "cpuCores")]
    pub cpu_cores: usize,
    #[serde(rename = "memoryMb")]
    pub memory_mb: u64,
}

#[tauri::command]
pub fn get_client_runtime_info(storage: State<Storage>) -> Result<ClientRuntimeInfo, String> {
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let user_name = whoami::username();

    // Persist device_id so it stays stable across restarts
    let existing = storage.get("deviceId", None);
    let device_id = if let Some(id) = existing.as_str() {
        if !id.is_empty() {
            id.to_string()
        } else {
            let new_id = format!("sayit-{}", uuid::Uuid::new_v4());
            let _ = storage.set("deviceId", &serde_json::json!(new_id));
            new_id
        }
    } else {
        let new_id = format!("sayit-{}", uuid::Uuid::new_v4());
        let _ = storage.set("deviceId", &serde_json::json!(new_id));
        new_id
    };

    Ok(ClientRuntimeInfo {
        user_id: user_name.clone(),
        user_name,
        device_id,
        hostname,
        client_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        os_version: get_os_version(),
        local_ip: get_local_ip(),
        system_locale: get_system_locale(),
        cpu_cores: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        memory_mb: get_total_memory_mb(),
    })
}

/// Reports the system display language using frontend `Locale` tags (`en` / `uk`).
///
/// The frontend uses this result for `ui.language = 'auto'` instead of deriving
/// a value from `navigator.language`, which follows the WebView and can disagree
/// with `GetUserDefaultUILanguage`. The Rust resolver is the single source for both
/// the tray and the main interface.
#[tauri::command]
pub fn get_system_ui_language() -> String {
    crate::locale::system_ui_lang().tag().to_string()
}

#[tauri::command]
pub fn get_auto_launch(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_auto_launch(app: AppHandle, _enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if _enable {
        autostart.enable().map_err(|e| e.to_string())
    } else {
        autostart.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn append_debug_log(payload: Value) -> Result<(), String> {
    // Format a compact single-line representation for the log file
    let line = match payload {
        Value::Object(ref map) => {
            let kind = map.get("kind").and_then(|v| v.as_str()).unwrap_or("?");
            match kind {
                "runtime" => {
                    let level = map.get("level").and_then(|v| v.as_str()).unwrap_or("info");
                    let source = map.get("source").and_then(|v| v.as_str()).unwrap_or("");
                    let message = map.get("message").and_then(|v| v.as_str()).unwrap_or("");
                    let detail = map.get("detail");
                    if let Some(d) = detail {
                        format!("[{}] [{}] {} {}", level.to_uppercase(), source, message, d)
                    } else {
                        format!("[{}] [{}] {}", level.to_uppercase(), source, message)
                    }
                }
                "session_start" => {
                    let sid = map.get("sessionId").and_then(|v| v.as_str()).unwrap_or("?");
                    format!("[SESSION] start id={}", sid)
                }
                "session_end" => {
                    let sid = map.get("sessionId").and_then(|v| v.as_str()).unwrap_or("?");
                    let dur = map.get("durationMs").and_then(|v| v.as_i64()).unwrap_or(0);
                    let msgs = map
                        .get("messageCount")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    format!(
                        "[SESSION] end id={} duration={}ms messages={}",
                        sid, dur, msgs
                    )
                }
                "ws_message" => {
                    let dir = map.get("direction").and_then(|v| v.as_str()).unwrap_or("?");
                    let typ = map.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                    let data = map.get("data");
                    if let Some(d) = data {
                        format!("[WS] {} {} {}", dir, typ, d)
                    } else {
                        format!("[WS] {} {}", dir, typ)
                    }
                }
                _ => serde_json::to_string(&payload).unwrap_or_else(|_| format!("{:?}", payload)),
            }
        }
        _ => serde_json::to_string(&payload).unwrap_or_else(|_| format!("{:?}", payload)),
    };

    write_log_line(&line);
    Ok(())
}

/// 打开文件所在的文件夹（并选中文件）
#[tauri::command]
pub fn reveal_file_in_folder(file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // explorer /select, 会打开文件夹并高亮选中文件
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        let path = std::path::PathBuf::from(&file_path);
        let dir = path.parent().unwrap_or(&path);
        std::process::Command::new("xdg-open")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    Ok(())
}

/// 直接打开指定文件夹。
#[tauri::command]
pub fn open_folder(folder_path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&folder_path);
    if !path.is_dir() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;

    Ok(())
}
