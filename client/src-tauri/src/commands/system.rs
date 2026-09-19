use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use crate::storage::Storage;
use std::io::Write;
use std::sync::Mutex;
use base64::Engine;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

fn log_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("logs")
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
    let mut guard = LOG_FILE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
        cpu_cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
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

// ─── Auto-update ───
//
// Division of work: version checking lives in the frontend (updateChecker.ts fetches
// the pinned fork release manifest and compares versions); Rust is the trusted boundary
// for downloading, integrity verification, and launching the installer. Three commands:
//   · download_update                  download the fork release installer, verify the
//                                      mandatory SHA-512, and authorize it in-memory
//   · install_downloaded_update        launch the installer only for a package this
//                                      process itself downloaded and verified
//   · clear_legacy_update_artifacts    one-way startup migration from the pre-fork flow
//
// Security boundary: the frontend never supplies a local path, an optional hash, or an
// alternate host. The installable package is whatever this process validated during
// download, tracked in VERIFIED_UPDATE; a file merely existing on disk authorizes
// nothing. Update installation never happens on exit — only after the user's explicit
// download-and-install action.

const FORK_RELEASE_HOST: &str = "github.com";
const FORK_REPOSITORY: &str = "catgirl3d/SayIt";
const UPDATE_TEMP_DIR_NAME: &str = "sayit-update";

/// Canonical Base64 of a 64-byte SHA-512 digest: exactly 88 characters, `==` padding.
/// Must stay identical to the frontend pattern in updateChecker.ts.
static SHA512_BASE64_PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"^[A-Za-z0-9+/]{86}==$").expect("valid SHA-512 Base64 pattern")
});

/// Exact numeric major.minor.patch; pre-release channels are out of scope.
static NUMERIC_VERSION_PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"^\d+\.\d+\.\d+$").expect("valid version pattern")
});

/// HTTPS hosts the installer download may be redirected to. GitHub serves release
/// assets from these CDNs; anything else fails closed.
const ALLOWED_REDIRECT_HOSTS: [&str; 3] = [
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
];

fn redirect_target_allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| ALLOWED_REDIRECT_HOSTS.contains(&host))
}

/// Pure decision for one redirect hop, mirroring reqwest's own `Policy::limited(5)`
/// semantics exactly (reqwest 0.12 redirect.rs: `previous().len() > max` errors, and
/// `previous()` includes the initial URL, so this follows at most five redirects).
/// The policy closure below maps Ok→follow, Err→error; this seam is what tests lock.
fn redirect_hop_allowed(previous_len: usize, url: &reqwest::Url) -> Result<(), &'static str> {
    if previous_len > 5 {
        Err("too many redirects")
    } else if redirect_target_allowed(url) {
        Ok(())
    } else {
        Err("redirect to a host outside the fork release infrastructure")
    }
}

/// The redirect policy follows at most five HTTPS hops, each landing on an allowed
/// host. The initial URL is validated separately, before the first request.
fn update_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| match redirect_hop_allowed(
        attempt.previous().len(),
        attempt.url(),
    ) {
        Ok(()) => attempt.follow(),
        Err(reason) => attempt.error(reason),
    })
}

fn installer_filename(version: &str) -> String {
    format!("SayIt_{}_x64-setup.exe", version)
}

fn update_temp_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(UPDATE_TEMP_DIR_NAME)
}

fn final_package_path(version: &str) -> std::path::PathBuf {
    update_temp_dir().join(installer_filename(version))
}

/// The in-flight download target: the final path with a `.part` suffix, so an
/// interrupted download can never leave a file that looks installable.
fn part_package_path(final_path: &std::path::Path) -> std::path::PathBuf {
    let mut name = final_path.as_os_str().to_os_string();
    name.push(".part");
    std::path::PathBuf::from(name)
}

fn validate_numeric_version(version: &str) -> Result<(), String> {
    if NUMERIC_VERSION_PATTERN.is_match(version) {
        Ok(())
    } else {
        Err(format!("Invalid update version: {}", version))
    }
}

/// The only installer URL accepted from the frontend: the fork's own release asset for
/// exactly the version the manifest declared. Derived, never freeform-compared.
fn validate_fork_release_url(url: &str, version: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid update URL: {}", e))?;
    if parsed.scheme() != "https" {
        return Err(format!("Insecure update URL scheme: {}", parsed.scheme()));
    }
    if parsed.host_str() != Some(FORK_RELEASE_HOST) {
        return Err(format!("Update URL host is not {}: {}", FORK_RELEASE_HOST, parsed.host_str().unwrap_or("(none)")));
    }
    // Exactly this URL, nothing that smuggles extra meaning: no port, no query,
    // no fragment, no userinfo. A query or fragment could silently change what the
    // URL identifies; a port or userinfo means it is not the canonical release asset.
    if parsed.port().is_some() {
        return Err(format!("Update URL must not carry a non-default port: {}", url));
    }
    if parsed.query().is_some() {
        return Err(format!("Update URL must not carry a query string: {}", url));
    }
    if parsed.fragment().is_some() {
        return Err(format!("Update URL must not carry a fragment: {}", url));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("Update URL must not carry userinfo: {}", url));
    }
    let expected_path = format!(
        "/{}/releases/download/v{}/{}",
        FORK_REPOSITORY,
        version,
        installer_filename(version)
    );
    if parsed.path() != expected_path {
        return Err(format!("Update URL does not point at the fork release asset: {}", url));
    }
    Ok(())
}

/// Validate the manifest's SHA-512: canonical padded Base64 that decodes to exactly
/// 64 bytes. Returns the decoded digest bytes for stream comparison.
fn validate_sha512_base64(sha512: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    if !SHA512_BASE64_PATTERN.is_match(sha512) {
        return Err("Invalid update SHA-512: not canonical padded Base64 of 64 bytes".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(sha512)
        .map_err(|e| format!("Invalid update SHA-512: {}", e))?;
    if bytes.len() != 64 {
        return Err(format!("Invalid update SHA-512: {} bytes instead of 64", bytes.len()));
    }
    Ok(bytes)
}

/// A package this process downloaded and hash-verified. Authorization to install:
/// the only state install_downloaded_update trusts, and it never comes from disk or
/// from frontend arguments.
struct VerifiedUpdate {
    version: String,
    /// Canonical Base64 exactly as the manifest carried it.
    sha512: String,
    path: std::path::PathBuf,
}

static VERIFIED_UPDATE: std::sync::LazyLock<std::sync::Mutex<Option<VerifiedUpdate>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// One guard for the whole update machinery: download and install serialize mutually.
/// Concurrent downloads must not write the same `.part` file, and an install must
/// not re-hash or spawn while a download could revoke or replace the authorized
/// package between the authorization check and the spawn.
static UPDATE_OP_IN_PROGRESS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Pure authorization decision for the install command: install only proceeds for a
/// version/hash pair this process verified during download, never for a file that
/// merely exists on disk. Extracted as a pure seam so tests cover the rule without
/// needing a Tauri window.
fn authorize_install(
    verified: Option<&VerifiedUpdate>,
    version: &str,
    sha512: &str,
) -> Result<std::path::PathBuf, String> {
    match verified {
        Some(v) if v.version == version && v.sha512 == sha512 => Ok(v.path.clone()),
        _ => Err("No update package was downloaded and verified by this process".to_string()),
    }
}

/// A locked mutex guard helper shared with the poisoned-log pattern above: a panic in
/// one thread must not permanently lock out every later update operation.
fn lock_verified_update() -> std::sync::MutexGuard<'static, Option<VerifiedUpdate>> {
    VERIFIED_UPDATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One-way startup migration away from the pre-fork update flow.
///
/// The old flow persisted `pendingUpdate` in settings and installed it silently on
/// exit. This fork builds must never run that flow: the key is deleted WITHOUT reading
/// its filePath (a persisted path is attacker-controllable data, never an installer
/// instruction), and the fixed temp directory is cleared of stale packages. Idempotent:
/// safe to call on every startup.
#[tauri::command]
pub fn clear_legacy_update_artifacts(storage: State<Storage>) -> Result<(), String> {
    storage.delete("pendingUpdate").map_err(|e| e.to_string())?;
    clear_update_temp_dir(&update_temp_dir());
    Ok(())
}

/// Remove top-level files and links inside the fixed update directory. Child
/// directories and reparse targets are skipped, the directory itself is kept, and a
/// locked file is only logged — cleanup must never turn into a failure that blocks
/// startup or, worse, into removal of anything outside this one directory.
fn clear_update_temp_dir(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(e) => {
                write_log_line(&format!("[update] legacy cleanup could not stat {}: {}", path.display(), e));
                continue;
            }
        };
        if file_type.is_file() || file_type.is_symlink() {
            if let Err(e) = std::fs::remove_file(&path) {
                write_log_line(&format!(
                    "[update] legacy cleanup could not remove {}: {}",
                    path.display(),
                    e
                ));
            }
        }
    }
}

/// Compute a file's SHA-512 as **Base64** — the same encoding as the manifest's
/// sha512 field. (The old PowerShell tooling converted Get-FileHash hex to Base64;
/// never compare against hex.)
fn file_sha512_base64(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha512};
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open the installer file: {}", e))?;
    let mut hasher = Sha512::new();
    // Installers are tens of MB; read in chunks instead of buffering whole file
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = std::io::Read::read(&mut file, &mut buffer)
            .map_err(|e| format!("Failed to read the installer file: {}", e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(hasher.finalize()))
}

/// Confirm the on-disk installer is still the exact bytes that were verified:
/// existence plus mandatory full-hash match. No hash argument means no package.
/// A mismatch is definitive corruption (the caller deletes the bytes); an I/O
/// failure is transient (the caller keeps the file and revokes authorization).
#[derive(Debug)]
enum PackageVerifyError {
    Mismatch,
    Unavailable(String),
}

fn verify_package_file(path: &std::path::Path, expected_base64: &str) -> Result<(), PackageVerifyError> {
    if !path.is_file() {
        return Err(PackageVerifyError::Unavailable("The installer file does not exist".to_string()));
    }
    match file_sha512_base64(path) {
        Ok(actual) if actual == expected_base64 => Ok(()),
        Ok(_) => Err(PackageVerifyError::Mismatch),
        Err(e) => Err(PackageVerifyError::Unavailable(e)),
    }
}

#[derive(Serialize, Clone)]
struct UpdateDownloadProgress {
    #[serde(rename = "downloadedBytes")]
    downloaded_bytes: u64,
    #[serde(rename = "totalBytes")]
    total_bytes: u64,
    percent: f64,
    status: String,
    error: Option<String>,
}

fn emit_update_progress(app: &AppHandle, downloaded: u64, total: u64, status: &str, error: Option<&str>) {
    let percent = if total > 0 {
        (downloaded as f64 / total as f64 * 100.0).min(100.0)
    } else {
        0.0
    };
    let _ = app.emit(
        "update-download-progress",
        UpdateDownloadProgress {
            downloaded_bytes: downloaded,
            total_bytes: total,
            percent,
            status: status.to_string(),
            error: error.map(String::from),
        },
    );
}

/// Download the fork release installer into the fixed temp directory, reporting real
/// byte progress through the update-download-progress event.
///
/// Request validation is strict: the URL must be the canonical fork release asset for
/// exactly `version`, and `sha512` must be canonical padded Base64 decoding to 64
/// bytes. The package is written to a `.part` file while streaming its hash; only a
/// fully verified download is renamed to the final path and authorized in memory.
/// GitHub's release-asset CDN redirects are allowed, bounded to five hops, and
/// restricted to the allowed hosts — anything else fails closed.
#[tauri::command]
pub async fn download_update(app: AppHandle, url: String, version: String, sha512: String) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    // Serialize against every other update operation.
    if UPDATE_OP_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("An update operation is already in progress".to_string());
    }

    let result = run_verified_download(&app, &url, &version, &sha512).await;
    UPDATE_OP_IN_PROGRESS.store(false, Ordering::SeqCst);
    result
}

async fn run_verified_download(
    app: &AppHandle,
    url: &str,
    version: &str,
    sha512: &str,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha512};
    use std::io::Write;

    // Authorization for a previous download is revoked the moment a new one starts.
    *lock_verified_update() = None;

    validate_numeric_version(version)?;
    validate_fork_release_url(url, version)?;
    let expected_digest = validate_sha512_base64(sha512)?;

    // A User-Agent is mandatory: production AWS WAF's NoUserAgent_HEADER rule
    // rejects UA-less requests with 403.
    let client = reqwest::Client::builder()
        .user_agent(concat!("SayIt/", env!("CARGO_PKG_VERSION")))
        .redirect(update_redirect_policy())
        .build()
        .map_err(|e| format!("Failed to initialize download client: {}", e))?;

    emit_update_progress(app, 0, 0, "downloading", None);

    let resp = client
        .get(url)
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| {
            let msg = format!("Download failed: {}", e);
            emit_update_progress(app, 0, 0, "failed", Some(&msg));
            msg
        })?;

    if !resp.status().is_success() {
        let msg = format!("Download failed: HTTP {}", resp.status());
        emit_update_progress(app, 0, 0, "failed", Some(&msg));
        return Err(msg);
    }

    let total = resp.content_length().unwrap_or(0);

    // The final path is derived from the validated version — never from the URL,
    // never from frontend data.
    let temp_dir = update_temp_dir();
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temporary directory: {}", e))?;
    let final_path = final_package_path(version);
    let part_path = part_package_path(&final_path);

    let mut file = match std::fs::File::create(&part_path) {
        Ok(f) => f,
        Err(e) => {
            let msg = format!("Failed to create file: {}", e);
            emit_update_progress(app, 0, 0, "failed", Some(&msg));
            return Err(msg);
        }
    };

    let mut downloaded: u64 = 0;
    let mut hasher = Sha512::new();
    let mut stream = resp.bytes_stream();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("Download interrupted: {}", e);
                emit_update_progress(app, downloaded, total, "failed", Some(&msg));
                let _ = std::fs::remove_file(&part_path);
                return Err(msg);
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            let msg = format!("Failed to write file: {}", e);
            emit_update_progress(app, downloaded, total, "failed", Some(&msg));
            let _ = std::fs::remove_file(&part_path);
            return Err(msg);
        }
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;

        // Emit progress every 200ms to avoid flooding the event bus
        if last_emit.elapsed().as_millis() >= 200 {
            emit_update_progress(app, downloaded, total, "downloading", None);
            last_emit = std::time::Instant::now();
        }
    }

    if let Err(e) = file.flush() {
        let _ = std::fs::remove_file(&part_path);
        let msg = format!("Failed to flush file: {}", e);
        emit_update_progress(app, downloaded, total, "failed", Some(&msg));
        return Err(msg);
    }
    drop(file);

    // Verification happens BEFORE "completed": a hash mismatch must never leave an
    // authorized package behind.
    if hasher.finalize().as_slice() != expected_digest.as_slice() {
        let _ = std::fs::remove_file(&part_path);
        let msg = "Update package integrity check failed (SHA-512 mismatch)".to_string();
        write_log_line("[update] downloaded package failed SHA-512 verification, discarded");
        emit_update_progress(app, downloaded, total, "failed", Some(&msg));
        return Err(msg);
    }

    // A verified package replaces only its own fixed final path. If the replacement
    // fails, the .part file goes away and every other path stays untouched.
    if final_path.exists() {
        if let Err(e) = std::fs::remove_file(&final_path) {
            let _ = std::fs::remove_file(&part_path);
            let msg = format!("Failed to replace the previous package: {}", e);
            emit_update_progress(app, downloaded, total, "failed", Some(&msg));
            return Err(msg);
        }
    }
    if let Err(e) = std::fs::rename(&part_path, &final_path) {
        let _ = std::fs::remove_file(&part_path);
        let msg = format!("Failed to finalize the downloaded package: {}", e);
        emit_update_progress(app, downloaded, total, "failed", Some(&msg));
        return Err(msg);
    }

    // No second hash pass here: the streamed digest above was computed over the exact
    // bytes that were written, and the rename is a same-volume metadata move — it
    // cannot alter content. Replacement between now and the launch is caught by the
    // mandatory re-hash in install_downloaded_update, immediately before spawn.

    // The verified package is the only thing the fixed directory needs; other
    // versions lying around from earlier runs are now dead weight.
    prune_stale_packages(&temp_dir, &installer_filename(version));

    *lock_verified_update() = Some(VerifiedUpdate {
        version: version.to_string(),
        sha512: sha512.to_string(),
        path: final_path,
    });

    emit_update_progress(app, downloaded, total.max(downloaded), "completed", None);
    Ok(())
}

/// Remove every file in the update directory except `keep`.
///
/// Only called after the new package has been verified: a failed download leaves the
/// previous verified package in place, and wiping it early would throw away the
/// user's already-downloaded update for nothing.
/// Removal failures (file in use, etc.) are logged without erroring — cleanup
/// failure must not turn a successful download into a failed one.
fn prune_stale_packages(dir: &std::path::Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let matches_keep = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n == keep);
        if matches_keep {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(e) => write_log_line(&format!(
                "[update] could not remove the stale package {}: {}",
                path.display(),
                e
            )),
        }
    }
    if removed > 0 {
        write_log_line(&format!("[update] removed {} stale update package(s)", removed));
    }
}

/// Launch the NSIS installer silently (/S).
///
/// Silent NSIS offers no "run after install" hook, so we take over: spawn a "watchdog"
/// cmd process that does not depend on this process staying alive, wait for the
/// installer process to actually exit (file overwrite complete), then relaunch the
/// new exe. The old process must be fully gone before the exe can be overwritten
/// (Windows file lock), so the watchdog lives outside this process.
///
/// Critical: never pass a quoted, `&&`-containing compound command directly to
/// `cmd /C` — Rust wraps the whole space-containing argument in quotes and escapes
/// inner " as \", which cmd.exe does not understand, so paths get mangled
/// (historical bug: auto-restart after install reported "file not found"). Quotes
/// inside a script file are file literals and skip the argument-escaping layer;
/// passing a single script path to `cmd /C` is the one case cmd handles cleanly.
///
/// This always relaunches with --open-about: explicit installation is the only
/// caller, and the user is meant to see the About page confirming the update took
/// effect.
#[cfg(target_os = "windows")]
fn spawn_installer(installer_path: &str) -> Result<(), String> {
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Same path: currentUser install mode reinstalls into the original directory.
    // --open-about jumps to the About page so the user can confirm the update took.
    let relaunch_line = {
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Failed to get the current executable path: {}", e))?;
        format!("start \"\" \"{}\" --open-about\r\n", current_exe.to_string_lossy())
    };

    //   - ping buys ~1s so the old process has fully exited, avoiding the installer
    //     hitting a file lock while overwriting the exe
    //   - start /wait waits for the silent install to finish
    //   - del "%~f0" makes the script delete itself when done
    let script = format!(
        "@echo off\r\n\
         ping -n 2 127.0.0.1 >nul\r\n\
         start /wait \"\" \"{installer}\" /S\r\n\
         {relaunch_line}del \"%~f0\"\r\n",
        installer = installer_path,
        relaunch_line = relaunch_line,
    );
    let script_path = std::env::temp_dir().join("sayit-update-relaunch.bat");
    std::fs::write(&script_path, script)
        .map_err(|e| format!("Failed to write the update restart script: {}", e))?;

    Command::new("cmd")
        .args(["/C", &script_path.to_string_lossy()])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to start the installer watchdog: {}", e))?;
    Ok(())
}

/// Explicit user action "download and install": verify the authorized package one
/// last time, spawn the watchdog, then exit so the installer can replace the exe.
///
/// Authorization comes only from VERIFIED_UPDATE — state this process populated
/// during its own validated download. The version/hash pair from the frontend must
/// match it exactly; a file merely existing on disk authorizes nothing.
#[tauri::command]
pub fn install_downloaded_update(version: String, sha512: String, app: AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    // One guard covers install AND download: once held, a concurrent download can
    // neither revoke the authorization nor replace the package under us.
    if UPDATE_OP_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return Err("An update operation is already in progress".to_string());
    }

    let final_path = {
        let verified = lock_verified_update();
        match authorize_install(verified.as_ref(), &version, &sha512) {
            Ok(path) => path,
            Err(e) => {
                UPDATE_OP_IN_PROGRESS.store(false, Ordering::SeqCst);
                return Err(e);
            }
        }
    };

    // The package may have been replaced or corrupted between the download IPC call
    // and this one; re-hash right before spawning. A mismatch revokes authorization
    // and deletes the invalid package; a transient I/O failure revokes authorization
    // but keeps the bytes so a retry can still succeed.
    match verify_package_file(&final_path, &sha512) {
        Ok(()) => {}
        Err(PackageVerifyError::Mismatch) => {
            *lock_verified_update() = None;
            let _ = std::fs::remove_file(&final_path);
            UPDATE_OP_IN_PROGRESS.store(false, Ordering::SeqCst);
            write_log_line("[update] verified package no longer matches, installation refused");
            return Err("Update package integrity check failed (SHA-512 mismatch)".to_string());
        }
        Err(PackageVerifyError::Unavailable(e)) => {
            *lock_verified_update() = None;
            UPDATE_OP_IN_PROGRESS.store(false, Ordering::SeqCst);
            write_log_line(&format!(
                "[update] could not re-verify the package before spawn, installation refused: {}",
                e
            ));
            return Err(format!("The installer package could not be re-verified: {}", e));
        }
    }

    // Spawn the watchdog BEFORE exiting: if the spawn fails the app keeps running and
    // the verified package stays authorized for a retry; a successful spawn consumes
    // the authorization, then the app exits so the installer can replace the exe.
    //
    // Residual threat (explicitly out of scope by the plan): between the re-hash above
    // and the installer's first read of the file, another process running as the same
    // user could replace the fixed temp path. Same-user tampering can also replace the
    // app binary itself, so closing this window requires code signing, which this plan
    // excluded; the guarantee here is "the bytes came from the fork release and matched
    // the manifest at verification time", not "no local attacker exists".
    #[cfg(target_os = "windows")]
    match spawn_installer(&final_path.to_string_lossy()) {
        Ok(()) => {
            *lock_verified_update() = None;
            write_log_line("[update] installer launched after explicit user action (will relaunch)");
        }
        Err(e) => {
            // Keep the verified package authorized: the user can retry without
            // re-downloading the whole installer.
            UPDATE_OP_IN_PROGRESS.store(false, Ordering::SeqCst);
            return Err(e);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        UPDATE_OP_IN_PROGRESS.store(false, Ordering::SeqCst);
        let _ = &final_path;
        return Err("Automatic installation is not supported on this platform".to_string());
    }

    // Exit the current application so the installer can overwrite the exe
    app.exit(0);
    Ok(())
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
                    let msgs = map.get("messageCount").and_then(|v| v.as_i64()).unwrap_or(0);
                    format!("[SESSION] end id={} duration={}ms messages={}", sid, dur, msgs)
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
                _ => {
                    serde_json::to_string(&payload).unwrap_or_else(|_| format!("{:?}", payload))
                }
            }
        }
        _ => {
            serde_json::to_string(&payload).unwrap_or_else(|_| format!("{:?}", payload))
        }
    };

    write_log_line(&line);
    Ok(())
}

#[tauri::command]
pub fn save_audio_to_downloads(base64_data: String, filename: String) -> Result<String, String> {
    let downloads = dirs::download_dir()
        .ok_or_else(|| "Could not locate the Downloads directory".to_string())?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Failed to decode base64 audio: {}", e))?;

    let dest = downloads.join(&filename);
    std::fs::write(&dest, &bytes).map_err(|e| format!("Failed to write file: {}", e))?;

    let path_str = dest.to_string_lossy().to_string();
    write_log_line(&format!("[INFO] [audio] Audio saved to {}", path_str));
    Ok(path_str)
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

#[cfg(test)]
mod update_tests {
    use super::*;

    const VALID_SHA512: &str = "z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==";

    fn unique_update_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("sayit-update-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn accepts_exact_fork_release_url_and_64_byte_base64_sha512() {
        validate_numeric_version("0.2.1").unwrap();
        validate_fork_release_url(
            "https://github.com/catgirl3d/SayIt/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe",
            "0.2.1",
        )
        .unwrap();
        assert_eq!(validate_sha512_base64(VALID_SHA512).unwrap().len(), 64);
    }

    #[test]
    fn rejects_official_backend_other_repo_http_and_version_mismatch() {
        for url in [
            "https://sayitapp.site/api/desktop-updates/win32/x64/SayIt_0.2.1_x64-setup.exe",
            "https://github.com/crosswk/SayIt/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe",
            "http://github.com/catgirl3d/SayIt/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe",
            "https://github.com/catgirl3d/SayIt/releases/download/v0.2.2/SayIt_0.2.2_x64-setup.exe",
            "https://github.com/catgirl3d/SayIt/releases/download/v0.2.1/SayIt_0.2.2_x64-setup.exe",
            "https://github.com/catgirl3d/SayIt:8443/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe",
            "https://github.com/catgirl3d/SayIt/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe?x=1",
            "https://github.com/catgirl3d/SayIt/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe#frag",
            "https://user@github.com/catgirl3d/SayIt/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe",
            "https://user:pw@github.com/catgirl3d/SayIt/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe",
        ] {
            assert!(validate_fork_release_url(url, "0.2.1").is_err(), "{}", url);
        }
        assert!(validate_numeric_version("0.2").is_err());
        assert!(validate_numeric_version("0.2.1-beta").is_err());
        assert!(validate_numeric_version("v0.2.1").is_err());
    }

    #[test]
    fn rejects_missing_malformed_or_wrong_length_sha512() {
        use base64::Engine;
        assert!(validate_sha512_base64("").is_err());
        assert!(validate_sha512_base64("!!!not-base64!!!").is_err());
        // 64-byte digest without canonical `==` padding
        assert!(validate_sha512_base64(&VALID_SHA512.replace("==", "")).is_err());
        // One `=` dropped: 87 chars ending in a single `=`
        assert!(validate_sha512_base64(&VALID_SHA512.replace("==", "=")).is_err());
        // A 63-byte digest encodes to 84 unpadded chars, not the canonical 88
        let sixty_three_bytes = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 63]);
        assert!(validate_sha512_base64(&sixty_three_bytes).is_err());
        assert!(validate_sha512_base64(VALID_SHA512).is_ok());
    }

    #[test]
    fn legacy_cleanup_deletes_only_top_level_files_in_fixed_update_dir() {
        let dir = unique_update_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let sentinel = dir
            .parent()
            .unwrap()
            .join(format!("sayit-update-sentinel-{}", uuid::Uuid::new_v4()));
        std::fs::write(&sentinel, b"sentinel").unwrap();
        std::fs::write(dir.join("SayIt_0.2.1_x64-setup.exe"), b"installer").unwrap();
        std::fs::write(dir.join("SayIt_0.2.1_x64-setup.exe.part"), b"partial").unwrap();
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("nested").join("child.bin"), b"child").unwrap();

        clear_update_temp_dir(&dir);

        assert!(!dir.join("SayIt_0.2.1_x64-setup.exe").exists());
        assert!(!dir.join("SayIt_0.2.1_x64-setup.exe.part").exists());
        assert!(dir.is_dir());
        assert!(dir.join("nested").is_dir());
        assert!(dir.join("nested").join("child.bin").is_file());
        assert!(sentinel.is_file());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&sentinel);
    }

    #[test]
    fn redirect_policy_rejects_non_github_and_non_https_targets() {
        let parse = reqwest::Url::parse;
        assert!(redirect_target_allowed(&parse("https://github.com/x").unwrap()));
        assert!(redirect_target_allowed(
            &parse("https://release-assets.githubusercontent.com/x").unwrap()
        ));
        assert!(redirect_target_allowed(
            &parse("https://objects.githubusercontent.com/x").unwrap()
        ));
        assert!(!redirect_target_allowed(&parse("https://evil.example.com/x").unwrap()));
        assert!(!redirect_target_allowed(&parse("http://github.com/x").unwrap()));
    }

    #[test]
    fn redirect_hop_limit_follows_exactly_five_redirects() {
        // previous() includes the initial URL (reqwest 0.12 redirect.rs:135-141, the
        // same check its own Policy::limited uses), so the decision for redirect N
        // sees previous_len == N. Five redirects are followed; the sixth is refused.
        let target = reqwest::Url::parse("https://release-assets.githubusercontent.com/x").unwrap();
        for previous_len in 1..=5 {
            assert!(
                redirect_hop_allowed(previous_len, &target).is_ok(),
                "hop {} must be allowed",
                previous_len
            );
        }
        assert!(redirect_hop_allowed(6, &target).is_err());
        assert!(redirect_hop_allowed(1, &reqwest::Url::parse("https://evil.example.com/x").unwrap()).is_err());
    }

    #[test]
    fn verified_part_replaces_only_the_same_fixed_final_package() {
        use std::ffi::OsStr;
        let version = "0.2.1";
        let expected = final_package_path(version);
        assert_eq!(expected.parent(), Some(update_temp_dir().as_path()));
        assert_eq!(
            expected.file_name(),
            Some(OsStr::new("SayIt_0.2.1_x64-setup.exe"))
        );
        assert_eq!(
            part_package_path(&expected).file_name(),
            Some(OsStr::new("SayIt_0.2.1_x64-setup.exe.part"))
        );
    }

    #[test]
    fn package_verification_rejects_hash_mismatch_before_installer_spawn() {
        let dir = unique_update_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let package = dir.join("SayIt_0.2.1_x64-setup.exe");
        std::fs::write(&package, b"installer-bytes").unwrap();
        let actual = file_sha512_base64(&package).unwrap();

        verify_package_file(&package, &actual).unwrap();
        assert!(verify_package_file(&package, "wrong-digest").is_err());

        let _ = std::fs::remove_dir_all(&dir);
        assert!(verify_package_file(&package, &actual).is_err());
    }

    #[test]
    fn install_authorization_requires_a_download_verified_by_this_process() {
        let path = final_package_path("0.2.1");
        let verified = VerifiedUpdate {
            version: "0.2.1".to_string(),
            sha512: VALID_SHA512.to_string(),
            path: path.clone(),
        };

        assert!(authorize_install(None, "0.2.1", VALID_SHA512).is_err());
        assert!(authorize_install(Some(&verified), "0.2.2", VALID_SHA512).is_err());
        assert!(authorize_install(Some(&verified), "0.2.1", "wrong-digest").is_err());
        assert_eq!(authorize_install(Some(&verified), "0.2.1", VALID_SHA512).unwrap(), path);
    }
}
