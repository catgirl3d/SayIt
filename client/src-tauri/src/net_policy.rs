use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use reqwest::Url;
use tokio::sync::{oneshot, watch};

/// Environment-level WebView2 flags must be identical for every webview that shares
/// com.sayit.app/EBWebView. Keep them global; never copy them into a single window's
/// `additionalBrowserArgs` in tauri.conf.json (WebView2 rejects the second environment
/// with ERROR_INVALID_STATE when the option sets differ).
///
/// Do not add `--auto-accept-camera-and-microphone-capture` back. It handles permission
/// requests before WebView2 raises PermissionRequested, so the permission stays in the
/// "prompt" state and newer WebView2 builds hide device names and deviceIds from
/// enumerateDevices. Microphone access is granted by the PermissionRequested handler in
/// main.rs instead (an explicit Allow becomes a persistent grant and restores device
/// enumeration).
pub const DEFAULT_WEBVIEW2_BROWSER_ARGS: &str = "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling";
pub const BACKEND_BASE_URL_KEY: &str = "backendBaseUrl";

const CERTIFICATE_CACHE_TIMEOUT: Duration = Duration::from_secs(15);

/// The optional built-in default server URL, baked in by `build.rs` from the
/// `SAYIT_DEFAULT_SERVER_URL` environment variable. There is no file fallback; an empty value
/// means the build has no built-in server and no host is protected. `vite.config.ts` resolves the
/// frontend's `__SAYIT_DEFAULT_SERVER_URL__` from the same optional environment variable, so both
/// sides of the app agree on which host is the built-in default.
const BUILTIN_DEFAULT_SERVER_URL: &str = env!("SAYIT_BUILTIN_DEFAULT_SERVER_URL");

pub fn browser_args_from_environment() -> Result<(&'static str, String), String> {
    match std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        None => Ok(("app-default", DEFAULT_WEBVIEW2_BROWSER_ARGS.to_owned())),
        Some(value) => {
            let value = value.to_str().ok_or_else(|| {
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is not valid Unicode".to_owned()
            })?;
            validate_inherited_browser_args(value).map(|_| ("inherited", value.to_owned()))
        }
    }
}

#[cfg(windows)]
pub fn validate_inherited_browser_args(value: &str) -> Result<String, String> {
    use std::slice;

    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::UI::Shell::CommandLineToArgvW;
    use windows::core::{PCWSTR, PWSTR};

    if value.contains('\0') {
        return Err("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS contains a null character".to_owned());
    }

    let command_line = format!("sayit-webview2.exe {value}");
    let mut command_line_wide = command_line.encode_utf16().collect::<Vec<_>>();
    command_line_wide.push(0);
    let mut argument_count = 0;
    let arguments = unsafe {
        CommandLineToArgvW(
            PCWSTR::from_raw(command_line_wide.as_ptr()),
            &mut argument_count,
        )
    };

    if arguments.is_null() || argument_count < 1 {
        return Err("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS could not be parsed".to_owned());
    }

    let parsed = unsafe { slice::from_raw_parts(arguments, argument_count as usize) }
        .iter()
        .skip(1)
        .map(|argument: &PWSTR| unsafe { argument.to_string() })
        .collect::<Result<Vec<_>, _>>();
    let free_result = unsafe { LocalFree(HLOCAL(arguments.cast())) };
    if !free_result.is_invalid() {
        return Err(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS allocation could not be released".to_owned(),
        );
    }

    let parsed = parsed
        .map_err(|_| "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS contains invalid UTF-16".to_owned())?;
    for argument in parsed {
        if let Some(switch_name) = forbidden_browser_switch(&argument) {
            return Err(format!(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS contains forbidden switch '{switch_name}'"
            ));
        }
    }

    Ok(value.to_owned())
}

#[cfg(not(windows))]
pub fn validate_inherited_browser_args(value: &str) -> Result<String, String> {
    Ok(value.to_owned())
}

#[cfg(windows)]
fn forbidden_browser_switch(argument: &str) -> Option<String> {
    let argument = argument.trim();
    // Chromium on Windows also accepts "/" as a switch prefix (kSwitchPrefixes in base/command_line.cc).
    let switch = argument
        .strip_prefix("--")
        .or_else(|| argument.strip_prefix('-'))
        .or_else(|| argument.strip_prefix('/'))?;
    let switch_name = switch
        .split_once('=')
        .map_or(switch, |(name, _)| name)
        .to_ascii_lowercase();

    if switch_name.starts_with("ignore-certificate-errors")
        || matches!(
            switch_name.as_str(),
            "allow-insecure-localhost" | "edge-webview-switches"
        )
    {
        Some(switch_name)
    } else {
        None
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PolicySnapshot {
    saved_custom_host: Option<String>,
}

impl PolicySnapshot {
    fn from_saved_backend_url(
        saved_backend_url: Option<&str>,
        protected_host: Option<&str>,
    ) -> Self {
        let Some(saved_backend_url) = saved_backend_url else {
            return Self::default();
        };
        let Some(url) = parse_strict_url(saved_backend_url) else {
            return Self::default();
        };
        if url.scheme() != "https" || !valid_url_authority(&url) || !valid_port(&url) {
            return Self::default();
        }
        let Some(host) = canonical_host(&url) else {
            return Self::default();
        };
        if protected_host.is_some_and(|protected_host| is_protected_host(&host, protected_host)) {
            return Self::default();
        }
        Self {
            saved_custom_host: Some(host),
        }
    }

    fn allows_request(&self, request_uri: &str) -> bool {
        let Some(url) = parse_strict_url(request_uri) else {
            return false;
        };
        if !matches!(url.scheme(), "https" | "wss")
            || !valid_url_authority(&url)
            || !valid_port(&url)
        {
            return false;
        }
        let Some(host) = canonical_host(&url) else {
            return false;
        };
        // No protected-host check here: the request host must equal the saved host, and
        // `from_saved_backend_url` never stores a protected one.
        self.saved_custom_host
            .as_deref()
            .is_some_and(|saved_host| saved_host == host)
    }
}

pub fn cert_error_allowed(
    saved_backend_url: Option<&str>,
    protected_host: Option<&str>,
    request_uri: &str,
) -> bool {
    PolicySnapshot::from_saved_backend_url(saved_backend_url, protected_host)
        .allows_request(request_uri)
}

fn parse_strict_url(value: &str) -> Option<Url> {
    if value.is_empty()
        || value != value.trim()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        || value.contains('\\')
    {
        return None;
    }
    Url::parse(value).ok()
}

fn valid_url_authority(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some((_, authority_and_rest)) = url.as_str().split_once("://") else {
        return false;
    };
    let authority = authority_and_rest
        .split(|character| matches!(character, '/' | '?' | '#'))
        .next()
        .unwrap_or_default();
    !authority.contains('@')
}

fn valid_port(url: &Url) -> bool {
    url.port().is_none_or(|port| port != 0)
}

fn canonical_host(url: &Url) -> Option<String> {
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// Canonical host of the built-in default server, which never gets a certificate exception,
/// even when the user saves it as a custom address (Settings "Save and test" does exactly that
/// with the prefilled default). `None` when the build has no built-in server, or when the
/// compiled URL has no usable host (which the `build.rs` validation is meant to make
/// unreachable); then no host is protected.
fn builtin_default_host() -> Option<&'static str> {
    static HOST: OnceLock<Option<String>> = OnceLock::new();
    HOST.get_or_init(|| {
        if BUILTIN_DEFAULT_SERVER_URL.is_empty() {
            return None;
        }
        let host =
            parse_strict_url(BUILTIN_DEFAULT_SERVER_URL).and_then(|url| canonical_host(&url));
        if host.is_none() {
            log::error!(
                "Built-in default server URL '{BUILTIN_DEFAULT_SERVER_URL}' has no usable host; no host is protected from certificate exceptions"
            );
        }
        host
    })
    .as_deref()
}

fn is_protected_host(host: &str, protected_host: &str) -> bool {
    host == protected_host
        || host
            .strip_suffix(protected_host)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

#[derive(Clone)]
pub struct TlsPolicyState(Arc<TlsPolicyInner>);

struct TlsPolicyInner {
    initial_snapshot: PolicySnapshot,
    snapshot: RwLock<PolicySnapshot>,
    mutation: tokio::sync::Mutex<()>,
    readiness: watch::Sender<Option<Result<(), String>>>,
}

impl TlsPolicyState {
    pub fn new(saved_backend_url: Option<&str>) -> Self {
        let initial_snapshot =
            PolicySnapshot::from_saved_backend_url(saved_backend_url, builtin_default_host());
        let (readiness, _) = watch::channel(None);
        let state = Self(Arc::new(TlsPolicyInner {
            initial_snapshot: initial_snapshot.clone(),
            snapshot: RwLock::new(PolicySnapshot::default()),
            mutation: tokio::sync::Mutex::new(()),
            readiness,
        }));

        #[cfg(not(windows))]
        {
            let _ = state.complete_startup_success(initial_snapshot);
        }

        state
    }

    pub fn initial_snapshot(&self) -> PolicySnapshot {
        self.0.initial_snapshot.clone()
    }

    pub fn allows_request(&self, request_uri: &str) -> bool {
        self.0
            .snapshot
            .read()
            .map(|snapshot| snapshot.allows_request(request_uri))
            .unwrap_or(false)
    }

    pub fn with_request_decision<T>(
        &self,
        request_uri: &str,
        apply: impl FnOnce(bool) -> T,
    ) -> Option<T> {
        let snapshot = self.0.snapshot.try_read().ok()?;
        // Complete SetAction before a concurrent settings change disables grants
        // and clears the cached certificate decisions.
        Some(apply(snapshot.allows_request(request_uri)))
    }

    pub async fn wait_ready(&self) -> Result<(), String> {
        let mut receiver = self.0.readiness.subscribe();
        loop {
            if let Some(result) = receiver.borrow().clone() {
                return result;
            }

            match tokio::time::timeout(CERTIFICATE_CACHE_TIMEOUT, receiver.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    self.fail_startup("TLS readiness channel closed".to_owned());
                    return self.readiness_result();
                }
                Err(_) => {
                    self.fail_startup("TLS startup did not complete in time".to_owned());
                    return self.readiness_result();
                }
            }
        }
    }

    pub async fn apply_backend_change<C, CFut, P>(
        &self,
        new_saved_backend_url: Option<String>,
        clear: C,
        persist: P,
    ) -> Result<(), String>
    where
        C: FnOnce() -> CFut,
        CFut: Future<Output = Result<(), String>>,
        P: FnOnce() -> Result<(), String>,
    {
        if let Err(readiness_error) = self.wait_ready().await {
            // Startup failure is terminal: the snapshot stays at its default and denies every
            // certificate error, so the app is already fail-closed and saving the address must
            // not be blocked. The cache clear is skipped on purpose: the snapshot never allowed
            // a custom host, so WebView2 holds no ALWAYS_ALLOW decision to revoke, and the same
            // WebView2 interface failure would only repeat and fail the save.
            let _mutation = self.0.mutation.lock().await;
            log::warn!(
                "Custom-server certificate exception is unavailable; saving the backend address without it: {readiness_error}"
            );
            return persist();
        }
        let _mutation = self.0.mutation.lock().await;
        let previous_snapshot = self.current_snapshot()?;
        let next_snapshot = PolicySnapshot::from_saved_backend_url(
            new_saved_backend_url.as_deref(),
            builtin_default_host(),
        );

        self.set_snapshot(PolicySnapshot::default())?;
        clear().await?;

        match persist() {
            Ok(()) => {
                self.set_snapshot(next_snapshot)?;
                Ok(())
            }
            Err(error) => {
                self.set_snapshot(previous_snapshot)?;
                Err(error)
            }
        }
    }

    pub fn complete_startup_success(&self, snapshot: PolicySnapshot) -> Result<(), String> {
        self.0.readiness.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(self.set_snapshot(snapshot));
            true
        });
        self.readiness_result()
    }

    pub fn fail_startup(&self, error: String) {
        self.0.readiness.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(Err(error));
            true
        });
    }

    fn readiness_result(&self) -> Result<(), String> {
        self.0
            .readiness
            .borrow()
            .clone()
            .unwrap_or_else(|| Err("TLS startup did not produce a result".to_owned()))
    }

    fn current_snapshot(&self) -> Result<PolicySnapshot, String> {
        self.0
            .snapshot
            .read()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| "TLS policy snapshot lock is poisoned".to_owned())
    }

    fn set_snapshot(&self, snapshot: PolicySnapshot) -> Result<(), String> {
        *self
            .0
            .snapshot
            .write()
            .map_err(|_| "TLS policy snapshot lock is poisoned".to_owned())? = snapshot;
        Ok(())
    }

    #[cfg(windows)]
    pub async fn clear_cached_actions(app: tauri::AppHandle) -> Result<(), String> {
        use tauri::Manager;

        let main_window = app
            .get_webview_window("main")
            .ok_or_else(|| "main WebView window is unavailable".to_owned())?;
        let (sender, receiver) = oneshot::channel();
        let completion = Arc::new(Mutex::new(Some(sender)));
        let completion_for_dispatch = Arc::clone(&completion);
        main_window
            .with_webview(move |webview| {
                let send = |result: Result<(), String>| {
                    send_clear_completion(&completion_for_dispatch, result);
                };
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_14;
                use windows_core::Interface;

                unsafe {
                    let core = match webview.controller().CoreWebView2() {
                        Ok(core) => core,
                        Err(error) => {
                            send(Err(format!(
                                "failed to retrieve WebView2 core interface: {error:?}"
                            )));
                            return;
                        }
                    };
                    let core14 = match core.cast::<ICoreWebView2_14>() {
                        Ok(core14) => core14,
                        Err(error) => {
                            send(Err(format!(
                                "failed to cast WebView2 core to ICoreWebView2_14: {error:?}"
                            )));
                            return;
                        }
                    };
                    let completion_for_callback = Arc::clone(&completion_for_dispatch);
                    if let Err(error) =
                        begin_clear_server_certificate_error_actions(core14, move |result| {
                            send_clear_completion(&completion_for_callback, result)
                        })
                    {
                        send(Err(error));
                    }
                }
            })
            .map_err(|error| format!("failed to dispatch TLS cache clear: {error}"))?;
        match tokio::time::timeout(CERTIFICATE_CACHE_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("TLS cache clear completion was dropped".to_owned()),
            Err(_) => Err("TLS cache clear timed out".to_owned()),
        }
    }

    #[cfg(not(windows))]
    pub async fn clear_cached_actions(_app: tauri::AppHandle) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(windows)]
fn send_clear_completion(
    completion: &Arc<Mutex<Option<oneshot::Sender<Result<(), String>>>>>,
    result: Result<(), String>,
) {
    match completion.lock() {
        Ok(mut sender) => {
            if let Some(sender) = sender.take() {
                let _ = sender.send(result);
            }
        }
        Err(_) => log::error!("TLS clear completion lock is poisoned"),
    }
}

#[cfg(windows)]
pub fn begin_clear_server_certificate_error_actions(
    core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_14,
    on_complete: impl FnOnce(Result<(), String>) + Send + 'static,
) -> Result<(), String> {
    use webview2_com::ClearServerCertificateErrorActionsCompletedHandler;

    let handler =
        ClearServerCertificateErrorActionsCompletedHandler::create(Box::new(move |result| {
            on_complete(
                result.map_err(|error| format!("WebView2 TLS cache clear failed: {error:?}")),
            );
            Ok(())
        }));
    unsafe {
        core.ClearServerCertificateErrorActions(&handler)
            .map_err(|error| format!("WebView2 TLS cache clear could not start: {error:?}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[test]
    fn certificate_exception_matrix_is_strict_for_builtin_host_and_custom_host_wide() {
        let protected_host = Some("builtin.example");
        let cases = [
            (
                Some("https://custom.example:8443"),
                "https://custom.example:9443/healthz",
                true,
            ),
            (
                Some("https://custom.example:8443"),
                "wss://custom.example:9443/socket",
                true,
            ),
            (
                Some("https://custom.example:8443"),
                "https://custom.example/healthz",
                true,
            ),
            (
                Some("https://custom.example:8443"),
                "https://other.example:8443/healthz",
                false,
            ),
            (
                Some("https://custom.example:8443"),
                "http://custom.example:8443/healthz",
                false,
            ),
            (
                Some("https://custom.example:8443"),
                "ws://custom.example:8443/socket",
                false,
            ),
            (None, "https://custom.example:8443/healthz", false),
            (
                Some("https://builtin.example:8443"),
                "https://builtin.example:9443/healthz",
                false,
            ),
            (
                Some("https://builtin.example:8443"),
                "https://api.builtin.example/healthz",
                false,
            ),
            (
                Some("https://builtin.example.evil:8443"),
                "https://builtin.example.evil:9443/healthz",
                true,
            ),
            (
                Some("https://custom.example"),
                "https://custom.example./healthz",
                true,
            ),
            (
                Some("https://builtin.example"),
                "https://builtin.example./healthz",
                false,
            ),
            (
                Some("https://[::1]:8443"),
                "https://[::1]:9443/healthz",
                true,
            ),
            (
                Some("https://[::1]:8443"),
                "https://[::2]:9443/healthz",
                false,
            ),
            (
                Some("https://custom.example:8443"),
                "https://custom.example:0/healthz",
                false,
            ),
            (
                Some("https://custom.example:0"),
                "https://custom.example:8443/healthz",
                false,
            ),
            (
                Some("https://user:password@custom.example"),
                "https://custom.example/healthz",
                false,
            ),
            (
                Some("https://custom.example"),
                "https://user:password@custom.example/healthz",
                false,
            ),
            (
                Some("https://bu\u{0456}ltin.example"),
                "https://bu\u{0456}ltin.example/healthz",
                true,
            ),
            (Some("https://custom.example"), "not a URL", false),
        ];

        for (saved, request, expected) in cases {
            assert_eq!(
                cert_error_allowed(saved, protected_host, request),
                expected,
                "saved={saved:?}, request={request}"
            );
        }
    }

    #[test]
    fn certificate_exception_matrix_without_protected_host_is_strict_for_custom_host() {
        let cases = [
            (
                Some("https://custom.example"),
                "https://custom.example/healthz",
                true,
            ),
            (
                Some("https://custom.example"),
                "https://other.example/healthz",
                false,
            ),
            (
                Some("http://custom.example"),
                "https://custom.example/healthz",
                false,
            ),
            (None, "https://custom.example/healthz", false),
        ];

        for (saved, request, expected) in cases {
            assert_eq!(
                cert_error_allowed(saved, None, request),
                expected,
                "saved={saved:?}, request={request}"
            );
        }
    }

    #[test]
    fn compiled_builtin_default_server_never_gets_a_certificate_exception() {
        if BUILTIN_DEFAULT_SERVER_URL.is_empty() {
            assert_eq!(builtin_default_host(), None);
            return;
        }

        let host = builtin_default_host()
            .expect("the compiled built-in default server URL must yield a host");
        let state = TlsPolicyState::new(Some(BUILTIN_DEFAULT_SERVER_URL));
        state
            .complete_startup_success(state.initial_snapshot())
            .unwrap();

        assert!(!state.allows_request(&format!("https://{host}/healthz")));
        assert!(!state.allows_request(&format!("wss://{host}:9443/socket")));
        assert!(!state.allows_request(&format!("https://api.{host}/healthz")));
    }

    #[test]
    fn failed_cache_clear_leaves_storage_unchanged_and_policy_denied() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .set("backendBaseUrl", &json!("https://old.example:8443"))
            .unwrap();
        let state = TlsPolicyState::new(Some("https://old.example:8443"));
        state
            .complete_startup_success(state.initial_snapshot())
            .unwrap();

        let result = tauri::async_runtime::block_on(state.apply_backend_change(
            Some("https://new.example:9443".to_owned()),
            || async { Err("cache clear failed".to_owned()) },
            || {
                storage
                    .set("backendBaseUrl", &json!("https://new.example:9443"))
                    .map_err(|error| error.to_string())
            },
        ));

        assert_eq!(result, Err("cache clear failed".to_owned()));
        assert_eq!(
            storage.get("backendBaseUrl", None),
            json!("https://old.example:8443")
        );
        assert!(!state.allows_request("https://old.example:8443/healthz"));
        assert!(!state.allows_request("https://new.example:9443/healthz"));

        tauri::async_runtime::block_on(state.apply_backend_change(
            Some("https://new.example:9443".to_owned()),
            || async { Ok(()) },
            || {
                storage
                    .set("backendBaseUrl", &json!("https://new.example:9443"))
                    .map_err(|error| error.to_string())
            },
        ))
        .unwrap();
        assert!(state.allows_request("https://new.example:9443/healthz"));
    }

    #[test]
    fn failed_persistence_after_clear_restores_previous_saved_snapshot() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .set("backendBaseUrl", &json!("https://old.example:8443"))
            .unwrap();
        let state = TlsPolicyState::new(Some("https://old.example:8443"));
        state
            .complete_startup_success(state.initial_snapshot())
            .unwrap();

        let result = tauri::async_runtime::block_on(state.apply_backend_change(
            Some("https://new.example:9443".to_owned()),
            || async { Ok(()) },
            || Err("database write failed".to_owned()),
        ));

        assert_eq!(result, Err("database write failed".to_owned()));
        assert_eq!(
            storage.get("backendBaseUrl", None),
            json!("https://old.example:8443")
        );
        assert!(state.allows_request("https://old.example:9443/healthz"));
        assert!(!state.allows_request("https://new.example:9443/healthz"));
    }

    #[test]
    fn successful_change_clears_before_persisting_and_then_activates_new_host() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        let state = TlsPolicyState::new(Some("https://old.example:8443"));
        state
            .complete_startup_success(state.initial_snapshot())
            .unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));

        let clear_order = Arc::clone(&order);
        let persist_order = Arc::clone(&order);
        tauri::async_runtime::block_on(state.apply_backend_change(
            Some("https://new.example:9443".to_owned()),
            move || {
                clear_order.lock().unwrap().push("clear");
                async { Ok(()) }
            },
            || {
                assert_eq!(*persist_order.lock().unwrap(), vec!["clear"]);
                persist_order.lock().unwrap().push("persist");
                storage
                    .set("backendBaseUrl", &json!("https://new.example:9443"))
                    .map_err(|error| error.to_string())
            },
        ))
        .unwrap();

        assert_eq!(*order.lock().unwrap(), vec!["clear", "persist"]);
        assert_eq!(
            storage.get("backendBaseUrl", None),
            json!("https://new.example:9443")
        );
        assert!(!state.allows_request("https://old.example:8443/healthz"));
        assert!(state.allows_request("wss://new.example:8443/socket"));
    }

    #[test]
    fn certificate_callback_is_not_blocked_by_persistence() {
        let state = TlsPolicyState::new(Some("https://old.example:8443"));
        state
            .complete_startup_success(state.initial_snapshot())
            .unwrap();
        let mut observed_decision = None;
        let mut callback_thread = None;

        let result = tauri::async_runtime::block_on(state.apply_backend_change(
            Some("https://new.example:9443".to_owned()),
            || async { Ok(()) },
            || {
                let (sender, receiver) = std::sync::mpsc::channel();
                let callback_state = state.clone();
                callback_thread = Some(std::thread::spawn(move || {
                    let decision = callback_state
                        .with_request_decision("https://old.example:8443/healthz", |allowed| {
                            allowed
                        });
                    let _ = sender.send(decision);
                }));
                observed_decision = receiver.recv_timeout(Duration::from_millis(100)).ok();
                Ok(())
            },
        ));

        callback_thread.unwrap().join().unwrap();
        assert_eq!(result, Ok(()));
        assert_eq!(observed_decision, Some(Some(false)));
    }

    #[test]
    fn readiness_result_is_sticky_when_startup_finishes_before_waiter() {
        let state = TlsPolicyState::new(None);
        state
            .complete_startup_success(state.initial_snapshot())
            .unwrap();

        assert_eq!(
            tauri::async_runtime::block_on(async {
                tokio::time::timeout(Duration::from_millis(100), state.wait_ready()).await
            }),
            Ok(Ok(()))
        );
        assert_eq!(
            tauri::async_runtime::block_on(async {
                tokio::time::timeout(Duration::from_millis(100), state.wait_ready()).await
            }),
            Ok(Ok(()))
        );
    }

    #[cfg(windows)]
    #[test]
    fn startup_failure_is_terminal_and_cannot_activate_saved_host_late() {
        let state = TlsPolicyState::new(Some("https://custom.example:8443"));
        state.fail_startup("certificate handler registration failed".to_owned());

        assert_eq!(
            tauri::async_runtime::block_on(async {
                tokio::time::timeout(Duration::from_millis(100), state.wait_ready()).await
            }),
            Ok(Err("certificate handler registration failed".to_owned()))
        );
        assert_eq!(
            state.complete_startup_success(state.initial_snapshot()),
            Err("certificate handler registration failed".to_owned())
        );
        assert!(!state.allows_request("https://custom.example:9443/healthz"));
    }

    #[cfg(windows)]
    #[test]
    fn backend_change_after_startup_failure_persists_without_clearing_and_keeps_denying() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .set("backendBaseUrl", &json!("https://old.example:8443"))
            .unwrap();
        let state = TlsPolicyState::new(Some("https://old.example:8443"));
        state.fail_startup("certificate handler registration failed".to_owned());
        let clear_called = Arc::new(AtomicBool::new(false));

        let clear_flag = Arc::clone(&clear_called);
        let result = tauri::async_runtime::block_on(state.apply_backend_change(
            Some("https://new.example:9443".to_owned()),
            move || {
                clear_flag.store(true, Ordering::SeqCst);
                async { Ok(()) }
            },
            || {
                storage
                    .set("backendBaseUrl", &json!("https://new.example:9443"))
                    .map_err(|error| error.to_string())
            },
        ));

        assert_eq!(result, Ok(()));
        assert_eq!(
            storage.get("backendBaseUrl", None),
            json!("https://new.example:9443")
        );
        assert!(!clear_called.load(Ordering::SeqCst));
        assert!(!state.allows_request("https://old.example:8443/healthz"));
        assert!(!state.allows_request("https://new.example:9443/healthz"));

        let clear_flag = Arc::clone(&clear_called);
        let result = tauri::async_runtime::block_on(state.apply_backend_change(
            None,
            move || {
                clear_flag.store(true, Ordering::SeqCst);
                async { Ok(()) }
            },
            || {
                storage
                    .delete("backendBaseUrl")
                    .map_err(|error| error.to_string())
            },
        ));

        assert_eq!(result, Ok(()));
        assert_eq!(storage.get("backendBaseUrl", None), serde_json::Value::Null);
        assert!(!clear_called.load(Ordering::SeqCst));
        assert!(!state.allows_request("https://new.example:9443/healthz"));
    }

    #[cfg(windows)]
    #[test]
    fn inherited_webview_arguments_reject_certificate_bypasses_after_windows_parsing() {
        for unsafe_args in [
            "--ignore-certificate-errors",
            "\"--ignore-certificate-errors\"",
            "--ignore-certificate-errors=true",
            "--ignore-certificate-errors-spki-list=sha256/abc",
            "--allow-insecure-localhost",
            "--edge-webview-switches=\"--ignore-certificate-errors\"",
            "/ignore-certificate-errors",
            "/allow-insecure-localhost",
            "/IGNORE-CERTIFICATE-ERRORS=true",
        ] {
            assert!(
                validate_inherited_browser_args(unsafe_args).is_err(),
                "unsafe args were accepted: {unsafe_args}"
            );
        }

        let harmless =
            "--proxy-server=\"http://127.0.0.1:8080\" --disable-background-timer-throttling";
        assert_eq!(validate_inherited_browser_args(harmless).unwrap(), harmless);
    }
}
