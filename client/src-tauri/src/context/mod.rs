//! Window context detection — captures information about the foreground window
//! and focused element to determine text injection strategy.
//! Also runs a WinEvent hook that re-raises the overlay when the foreground window changes.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use windows::Win32::Foundation::HWND;
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GUITHREADINFO, GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetWindowTextW,
    GetWindowThreadProcessId,
};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextContext {
    /// UI Automation pattern used to obtain the text. Useful for diagnostics only.
    pub source: String,
    /// Text immediately before the caret/selection. Capped locally before serialization.
    pub text_before: String,
    /// Selected text. Empty means this is ordinary dictation rather than an edit command.
    pub selected_text: String,
    /// Text immediately after the caret/selection. Capped locally before serialization.
    pub text_after: String,
    /// A large selection is deliberately not sent to AI, because replacing a partial selection
    /// would risk data loss.
    pub selection_truncated: bool,
}

/// Why text capture succeeded or stopped. Only codes and timings: this reaches sayit.log.
///
/// `result` values are stable and greppable:
/// - `captured`: text was read; the frontend still decides whether it is usable
/// - `no_foreground`: no foreground window or application
/// - `uia_unavailable`: UI Automation could not start
/// - `no_focused_element`: the focused element could not be obtained
/// - `password`: a password control, never read by design
/// - `element_disabled`: the focused element is disabled or its enabled state is unreadable
/// - `no_text_pattern`: no readable text interface on the element or four ancestors
/// - `text_pattern2_cast_failed`: TextPattern2 existed but could not be cast to TextPattern,
///   and no other layer produced text
/// - `no_caret`: an interface exists but neither a caret nor a selection was available
/// - `empty`: text was readable but the caret surroundings and selection were empty
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextContextDiag {
    pub result: String,
    /// Layer where text was found, relative to the focused element (0 = the element itself).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u8>,
    /// Time spent in the text-capture step. UIA can be slow in some applications.
    pub elapsed_ms: u64,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn text_diag(result: &str, depth: Option<u8>, started: std::time::Instant) -> TextContextDiag {
    TextContextDiag {
        result: result.to_string(),
        depth,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct AppContext {
    pub reason: String,
    pub timestamp: i64,
    pub hwnd: String,
    pub pid: u32,
    pub tid: u32,
    #[serde(rename = "processName")]
    pub process_name: String,
    #[serde(rename = "exePath")]
    pub exe_path: String,
    #[serde(rename = "windowTitle")]
    pub window_title: String,
    #[serde(rename = "windowClass")]
    pub window_class: String,
    #[serde(rename = "focusHwnd")]
    pub focus_hwnd: String,
    #[serde(rename = "focusClass")]
    pub focus_class: String,
    #[serde(rename = "hasCaret")]
    pub has_caret: bool,
    #[serde(rename = "controlType")]
    pub control_type: String,
    #[serde(rename = "automationId")]
    pub automation_id: String,
    #[serde(rename = "isValuePatternAvailable")]
    pub is_value_pattern_available: bool,
    #[serde(rename = "isTextPatternAvailable")]
    pub is_text_pattern_available: bool,
    #[serde(rename = "isTextPattern2Available")]
    pub is_text_pattern2_available: bool,
    #[serde(rename = "isKeyboardFocusable")]
    pub is_keyboard_focusable: bool,
    #[serde(rename = "isEnabled")]
    pub is_enabled: bool,
    #[serde(rename = "isReadOnly")]
    pub is_read_only: Option<bool>,
    #[serde(rename = "isPassword")]
    pub is_password: bool,
    /// Present only when the user explicitly enabled context-aware writing. Ordinary foreground
    /// tracking and diagnostics never read or retain editor text.
    #[serde(rename = "textContext", skip_serializing_if = "Option::is_none")]
    pub text_context: Option<TextContext>,
    /// Present whenever the caller requested text, whether it was read or not.
    #[serde(rename = "textContextDiag", skip_serializing_if = "Option::is_none")]
    pub text_context_diag: Option<TextContextDiag>,
}

/// 前台窗口所在显示器的物理工作区，已排除任务栏。
#[derive(Debug, Clone)]
pub struct MonitorBounds {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub source: String,
}

pub struct ContextDetector {
    winevent_running: AtomicBool,
}

impl ContextDetector {
    pub fn new() -> Self {
        Self {
            winevent_running: AtomicBool::new(false),
        }
    }

    /// Capture the current foreground window context
    pub fn capture(&self, reason: &str) -> AppContext {
        capture_context_with_text(reason, false)
    }

    /// Capture the recording target, optionally including a bounded slice of editor text.
    /// This separate entry point is intentional: editor text is read only when the caller asks
    /// for it here, never by `capture` or `capture_context`, and never merely because the
    /// feature exists.
    pub fn capture_recording(&self, reason: &str, include_text_context: bool) -> AppContext {
        capture_context_with_text(reason, include_text_context)
    }

    /// Start the WinEvent hook that watches foreground window changes and, while the overlay is
    /// visible, re-raises it above the new foreground window. The hook does not capture or
    /// publish any application context.
    #[cfg(windows)]
    pub fn start_winevent_hook(&self, app: &AppHandle) {
        if self.winevent_running.swap(true, Ordering::SeqCst) {
            return; // already running
        }

        let app_handle = app.clone();

        thread::spawn(move || {
            use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook};
            use windows::Win32::UI::WindowsAndMessaging::{
                DispatchMessageW, GetMessageW, MSG, TranslateMessage,
            };

            // WinEvent constants
            const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
            const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;

            // Store app handle in thread-local for the callback
            thread_local! {
                static APP: std::cell::RefCell<Option<AppHandle>> = std::cell::RefCell::new(None);
            }

            APP.with(|a| *a.borrow_mut() = Some(app_handle));

            unsafe extern "system" fn winevent_proc(
                _hook: HWINEVENTHOOK,
                _event: u32,
                _hwnd: HWND,
                _id_object: i32,
                _id_child: i32,
                _event_thread: u32,
                _event_time: u32,
            ) {
                APP.with(|a| {
                    // Clone the handle so the RefCell borrow is not held across the sleep.
                    let Some(app) = a.borrow().as_ref().cloned() else {
                        return;
                    };
                    let state = app.state::<crate::window::WindowState>();
                    if !state.overlay_visible() {
                        return;
                    }
                    // After a foreground window switch, if the overlay is showing, push it back
                    // to the top. This covers the user switching to or opening an always-on-top
                    // program such as PotPlayer that pushes the overlay down. The short wait
                    // lets the new foreground window finish its own z-order changes first, so
                    // they do not undo the re-raise; 50 ms is the delay this hook has always
                    // used.
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    state.reassert_overlay_topmost_if_visible(&app);
                });
            }

            unsafe {
                let _fg_hook = SetWinEventHook(
                    EVENT_SYSTEM_FOREGROUND,
                    EVENT_SYSTEM_FOREGROUND,
                    None,
                    Some(winevent_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                );

                // Message loop required for WinEvent hooks
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });
    }

    #[cfg(not(windows))]
    pub fn start_winevent_hook(&self, _app: &AppHandle) {}
}

/// Standalone capture function (no &self needed, usable from callbacks)
#[cfg(windows)]
pub fn capture_context(reason: &str) -> AppContext {
    capture_context_with_text(reason, false)
}

#[cfg(windows)]
fn capture_context_with_text(reason: &str, include_text_context: bool) -> AppContext {
    let mut ctx = AppContext {
        reason: reason.to_string(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    };

    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.0 == std::ptr::null_mut() {
            if include_text_context {
                ctx.text_context_diag =
                    Some(text_diag("no_foreground", None, std::time::Instant::now()));
            }
            return ctx;
        }
        ctx.hwnd = format!("{}", foreground.0 as isize);

        let mut pid: u32 = 0;
        let tid = GetWindowThreadProcessId(foreground, Some(&mut pid));
        ctx.pid = pid;
        ctx.tid = tid;
        ctx.window_title = read_window_text(foreground);
        ctx.window_class = read_class_name(foreground);
        ctx.process_name = get_process_name(pid);
        ctx.exe_path = get_process_path(pid);

        let mut gui_info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(tid, &mut gui_info).is_ok() {
            let focus = gui_info.hwndFocus;
            if focus.0 != std::ptr::null_mut() {
                ctx.focus_hwnd = format!("{}", focus.0 as isize);
                ctx.focus_class = read_class_name(focus);
            }
            let caret = gui_info.hwndCaret;
            if caret.0 != std::ptr::null_mut() {
                let rc = gui_info.rcCaret;
                ctx.has_caret = (rc.right - rc.left) > 0 || (rc.bottom - rc.top) > 0;
            }
        }

        // UI Automation: get focused element's ControlType, ValuePattern, etc.
        // This is critical for Chromium-class windows where GetGUIThreadInfo
        // doesn't report caret/focus reliably.
        populate_uia_fields(&mut ctx, include_text_context);
    }
    ctx
}

/// 捕获当前前台窗口所在显示器的物理工作区。
#[cfg(windows)]
pub fn capture_foreground_monitor() -> Option<MonitorBounds> {
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.0 == std::ptr::null_mut() {
            return None;
        }

        let monitor = MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }

        let work = info.rcWork;
        if work.right <= work.left || work.bottom <= work.top {
            return None;
        }

        Some(MonitorBounds {
            left: work.left,
            top: work.top,
            right: work.right,
            bottom: work.bottom,
            source: "foreground_window".to_string(),
        })
    }
}

/// Use Windows UI Automation to query the focused element's properties.
/// Populates control_type, automation_id, is_value_pattern_available,
/// is_keyboard_focusable, is_enabled, is_read_only in AppContext.
#[cfg(windows)]
unsafe fn populate_uia_fields(ctx: &mut AppContext, include_text_context: bool) {
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, UIA_AutomationIdPropertyId, UIA_ControlTypePropertyId,
        UIA_IsEnabledPropertyId, UIA_IsKeyboardFocusablePropertyId, UIA_IsPasswordPropertyId,
        UIA_IsTextPattern2AvailablePropertyId, UIA_IsTextPatternAvailablePropertyId,
        UIA_IsValuePatternAvailablePropertyId, UIA_ValueIsReadOnlyPropertyId,
    };
    // CoInitialize for this thread (may already be initialized — that's ok)
    let co_init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let need_co_uninit = co_init_result.is_ok();

    let started = std::time::Instant::now();
    let result = (|| -> Result<(), String> {
        let uia: IUIAutomation = match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        {
            Ok(uia) => uia,
            Err(e) => {
                if include_text_context {
                    ctx.text_context_diag = Some(text_diag("uia_unavailable", None, started));
                }
                return Err(format!("CoCreateInstance CUIAutomation: {}", e));
            }
        };

        let focused = match uia.GetFocusedElement() {
            Ok(focused) => focused,
            Err(e) => {
                if include_text_context {
                    ctx.text_context_diag = Some(text_diag("no_focused_element", None, started));
                }
                return Err(format!("GetFocusedElement: {}", e));
            }
        };

        // ControlType (int → string name)
        let ct_val = focused.GetCurrentPropertyValue(UIA_ControlTypePropertyId);
        if let Ok(v) = ct_val {
            if let Ok(ct_id) = i32::try_from(&v) {
                ctx.control_type = uia_control_type_name(ct_id);
            }
        }

        // AutomationId
        let aid_val = focused.GetCurrentPropertyValue(UIA_AutomationIdPropertyId);
        if let Ok(v) = aid_val {
            if let Ok(bstr) = windows::core::BSTR::try_from(&v) {
                ctx.automation_id = bstr.to_string();
            }
        }

        // IsValuePatternAvailable
        let vp_val = focused.GetCurrentPropertyValue(UIA_IsValuePatternAvailablePropertyId);
        if let Ok(v) = vp_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_value_pattern_available = b;
            }
        }

        let tp_val = focused.GetCurrentPropertyValue(UIA_IsTextPatternAvailablePropertyId);
        if let Ok(v) = tp_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_text_pattern_available = b;
            }
        }

        let tp2_val = focused.GetCurrentPropertyValue(UIA_IsTextPattern2AvailablePropertyId);
        if let Ok(v) = tp2_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_text_pattern2_available = b;
            }
        }

        // Password controls are a hard boundary. Never ask a pattern for their value or text,
        // even when the user enabled context-aware writing globally.
        let password_val = focused.GetCurrentPropertyValue(UIA_IsPasswordPropertyId);
        if let Ok(v) = password_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_password = b;
            }
        }

        // IsKeyboardFocusable
        let kf_val = focused.GetCurrentPropertyValue(UIA_IsKeyboardFocusablePropertyId);
        if let Ok(v) = kf_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_keyboard_focusable = b;
            }
        }

        // IsEnabled
        let en_val = focused.GetCurrentPropertyValue(UIA_IsEnabledPropertyId);
        if let Ok(v) = en_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_enabled = b;
            }
        }

        // Value.IsReadOnly (only meaningful if ValuePattern is available)
        if ctx.is_value_pattern_available {
            let ro_val = focused.GetCurrentPropertyValue(UIA_ValueIsReadOnlyPropertyId);
            if let Ok(v) = ro_val {
                if let Ok(b) = bool::try_from(&v) {
                    ctx.is_read_only = Some(b);
                }
            }
        }

        if include_text_context {
            if ctx.is_password {
                ctx.text_context_diag = Some(text_diag("password", None, started));
            } else if !ctx.is_enabled {
                ctx.text_context_diag = Some(text_diag("element_disabled", None, started));
            } else {
                // Time only the text read; the property queries above run regardless.
                let text_started = std::time::Instant::now();
                let (text, result, depth) = capture_uia_text_context(&uia, &focused);
                ctx.text_context = text;
                ctx.text_context_diag = Some(text_diag(result, depth, text_started));
            }
        }

        Ok(())
    })();

    if let Err(e) = result {
        log::debug!("UIA populate failed (non-fatal): {}", e);
    }

    if need_co_uninit {
        CoUninitialize();
    }
}

#[cfg(windows)]
const TEXT_BEFORE_LIMIT: i32 = 500;
#[cfg(windows)]
const TEXT_AFTER_LIMIT: i32 = 300;
#[cfg(windows)]
const SELECTED_TEXT_LIMIT: i32 = 6000;

#[cfg(windows)]
enum TextPatternOutcome {
    Captured(TextContext),
    Failed(&'static str),
    Unavailable,
}

/// Decide what one element contributes. TextPattern2 is tried before TextPattern, and a failure
/// in either pattern must not hide a capture from the other or from an ancestor.
#[cfg(windows)]
fn choose_text_pattern_outcome(
    pattern2: TextPatternOutcome,
    text_pattern: TextPatternOutcome,
) -> (Option<TextContext>, Option<&'static str>) {
    let mut failure = None;
    for outcome in [pattern2, text_pattern] {
        match outcome {
            TextPatternOutcome::Captured(context) => return (Some(context), None),
            TextPatternOutcome::Failed(reason) => {
                failure = note_text_context_failure(failure, reason);
            }
            TextPatternOutcome::Unavailable => {}
        }
    }
    (None, failure)
}

#[cfg(windows)]
unsafe fn text_pattern2_outcome(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> TextPatternOutcome {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationTextPattern, IUIAutomationTextPattern2, UIA_TextPattern2Id,
    };
    use windows::core::Interface;

    let Ok(pattern2) = element.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id)
    else {
        return TextPatternOutcome::Unavailable;
    };
    let mut active = windows::Win32::Foundation::BOOL::default();
    let caret = pattern2
        .GetCaretRange(&mut active)
        .ok()
        .filter(|_| active.as_bool());
    match pattern2.cast::<IUIAutomationTextPattern>() {
        Ok(base) => match text_context_from_pattern(&base, caret, "text_pattern2") {
            Ok(context) => TextPatternOutcome::Captured(context),
            Err(reason) => TextPatternOutcome::Failed(reason),
        },
        Err(_) => TextPatternOutcome::Failed("text_pattern2_cast_failed"),
    }
}

#[cfg(windows)]
unsafe fn text_pattern_outcome(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> TextPatternOutcome {
    use windows::Win32::UI::Accessibility::{IUIAutomationTextPattern, UIA_TextPatternId};

    let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
    else {
        return TextPatternOutcome::Unavailable;
    };
    match text_context_from_pattern(&pattern, None, "text_pattern") {
        Ok(context) => TextPatternOutcome::Captured(context),
        Err(reason) => TextPatternOutcome::Failed(reason),
    }
}

/// Read a small, caret-relative slice rather than the whole document. TextPattern is attempted on
/// the focused element and a few ancestors because Chromium/Office often put it on the enclosing
/// Document element. ValuePattern is a conservative fallback for simple inputs and is treated as
/// text-before-caret only (most such controls expose no selection/caret API through UIA).
///
/// Returns the text, the diagnostic reason code, and the depth where text was found.
#[cfg(windows)]
unsafe fn capture_uia_text_context(
    uia: &windows::Win32::UI::Accessibility::IUIAutomation,
    focused: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> (Option<TextContext>, &'static str, Option<u8>) {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationElement, IUIAutomationValuePattern, UIA_ValuePatternId,
    };

    let mut element: IUIAutomationElement = focused.clone();
    let walker = uia.RawViewWalker().ok();
    let value_pattern = focused
        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        .ok();
    let value_pattern_present = value_pattern.is_some();
    let value_fallback = value_pattern
        .and_then(|pattern| pattern.CurrentValue().ok())
        .map(|value| sanitize_uia_text(&value.to_string()))
        .filter(|value| !value.is_empty());

    // The final reason when no layer produced text: an empty document is more useful than a
    // missing caret because it explains what the user is looking at.
    let mut pattern_failure: Option<&'static str> = None;

    for depth in 0..=4u8 {
        let (text, failure) = choose_text_pattern_outcome(
            text_pattern2_outcome(&element),
            text_pattern_outcome(&element),
        );
        if let Some(context) = text {
            return (Some(context), "captured", Some(depth));
        }
        if let Some(reason) = failure {
            pattern_failure = note_text_context_failure(pattern_failure, reason);
        }

        let Some(ref tree_walker) = walker else { break };
        let Ok(parent) = tree_walker.GetParentElement(&element) else {
            break;
        };
        element = parent;
    }

    if let Some(value) = value_fallback {
        let context = TextContext {
            source: "value_pattern_tail".to_string(),
            text_before: tail_chars(&value, TEXT_BEFORE_LIMIT as usize),
            ..Default::default()
        };
        return (Some(context), "captured", Some(0));
    }

    let reason = text_context_failure_reason(pattern_failure, value_pattern_present);
    (None, reason, None)
}

#[cfg(windows)]
unsafe fn text_context_from_pattern(
    pattern: &windows::Win32::UI::Accessibility::IUIAutomationTextPattern,
    caret: Option<windows::Win32::UI::Accessibility::IUIAutomationTextRange>,
    source: &str,
) -> Result<TextContext, &'static str> {
    use windows::Win32::UI::Accessibility::IUIAutomationTextRange;

    let selection_range = pattern.GetSelection().ok().and_then(|ranges| {
        (ranges.Length().ok().unwrap_or(0) > 0)
            .then(|| ranges.GetElement(0).ok())
            .flatten()
    });

    let mut selected_text = String::new();
    let mut selection_truncated = false;
    if let Some(ref range) = selection_range {
        if let Ok(text) = range.GetText(SELECTED_TEXT_LIMIT + 1) {
            let raw = sanitize_uia_text(&text.to_string());
            if raw.chars().count() > SELECTED_TEXT_LIMIT as usize {
                // Do not send a partial selection to AI: its output would replace the complete
                // selection and could silently discard content it never saw.
                selection_truncated = true;
            } else if !raw.trim().is_empty() {
                selected_text = raw;
            }
        }
    }

    let anchor: IUIAutomationTextRange = if !selected_text.is_empty() {
        selection_range.clone().ok_or("no_caret")?
    } else {
        caret.or(selection_range).ok_or("no_caret")?
    };

    let text_before = text_before_range(&anchor).unwrap_or_default();
    let text_after = text_after_range(&anchor).unwrap_or_default();
    if text_before.is_empty()
        && selected_text.is_empty()
        && text_after.is_empty()
        && !selection_truncated
    {
        return Err("empty");
    }

    Ok(TextContext {
        source: source.to_string(),
        text_before,
        selected_text,
        text_after,
        selection_truncated,
    })
}

#[cfg(windows)]
unsafe fn text_before_range(
    anchor: &windows::Win32::UI::Accessibility::IUIAutomationTextRange,
) -> Option<String> {
    use windows::Win32::UI::Accessibility::{
        TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start, TextUnit_Character,
    };
    let range = anchor.Clone().ok()?;
    range
        .MoveEndpointByRange(
            TextPatternRangeEndpoint_End,
            anchor,
            TextPatternRangeEndpoint_Start,
        )
        .ok()?;
    range
        .MoveEndpointByRange(
            TextPatternRangeEndpoint_Start,
            anchor,
            TextPatternRangeEndpoint_Start,
        )
        .ok()?;
    let _ = range.MoveEndpointByUnit(
        TextPatternRangeEndpoint_Start,
        TextUnit_Character,
        -TEXT_BEFORE_LIMIT,
    );
    range
        .GetText(TEXT_BEFORE_LIMIT)
        .ok()
        .map(|v| sanitize_uia_text(&v.to_string()))
}

#[cfg(windows)]
unsafe fn text_after_range(
    anchor: &windows::Win32::UI::Accessibility::IUIAutomationTextRange,
) -> Option<String> {
    use windows::Win32::UI::Accessibility::{
        TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start, TextUnit_Character,
    };
    let range = anchor.Clone().ok()?;
    range
        .MoveEndpointByRange(
            TextPatternRangeEndpoint_Start,
            anchor,
            TextPatternRangeEndpoint_End,
        )
        .ok()?;
    range
        .MoveEndpointByRange(
            TextPatternRangeEndpoint_End,
            anchor,
            TextPatternRangeEndpoint_End,
        )
        .ok()?;
    let _ = range.MoveEndpointByUnit(
        TextPatternRangeEndpoint_End,
        TextUnit_Character,
        TEXT_AFTER_LIMIT,
    );
    range
        .GetText(TEXT_AFTER_LIMIT)
        .ok()
        .map(|v| sanitize_uia_text(&v.to_string()))
}

fn sanitize_uia_text(value: &str) -> String {
    value
        .replace('\0', "")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

fn tail_chars(value: &str, limit: usize) -> String {
    let count = value.chars().count();
    value.chars().skip(count.saturating_sub(limit)).collect()
}

/// Keep the strongest reason seen across the ancestor walk. An empty document is more useful
/// than a missing caret because it explains what the user is looking at.
#[cfg(windows)]
fn note_text_context_failure(
    current: Option<&'static str>,
    reason: &'static str,
) -> Option<&'static str> {
    if current == Some("empty") {
        current
    } else {
        Some(reason)
    }
}

/// Pick the final reason when no layer produced text. When no pattern reported a reason, a
/// present-but-empty ValuePattern means the document is empty; a missing one means the
/// application exposes no text interface.
#[cfg(windows)]
fn text_context_failure_reason(
    pattern_failure: Option<&'static str>,
    value_pattern_present: bool,
) -> &'static str {
    pattern_failure.unwrap_or(if value_pattern_present {
        "empty"
    } else {
        "no_text_pattern"
    })
}

/// Map UIA ControlType ID to a human-readable name.
#[cfg(windows)]
fn uia_control_type_name(id: i32) -> String {
    match id {
        50000 => "Button".to_string(),
        50001 => "Calendar".to_string(),
        50002 => "CheckBox".to_string(),
        50003 => "ComboBox".to_string(),
        50004 => "Edit".to_string(),
        50005 => "Hyperlink".to_string(),
        50006 => "Image".to_string(),
        50007 => "ListItem".to_string(),
        50008 => "List".to_string(),
        50009 => "Menu".to_string(),
        50010 => "MenuBar".to_string(),
        50011 => "MenuItem".to_string(),
        50012 => "ProgressBar".to_string(),
        50013 => "RadioButton".to_string(),
        50014 => "ScrollBar".to_string(),
        50015 => "Slider".to_string(),
        50016 => "Spinner".to_string(),
        50017 => "StatusBar".to_string(),
        50018 => "Tab".to_string(),
        50019 => "TabItem".to_string(),
        50020 => "Text".to_string(),
        50021 => "ToolBar".to_string(),
        50022 => "ToolTip".to_string(),
        50023 => "Tree".to_string(),
        50024 => "TreeItem".to_string(),
        50025 => "Custom".to_string(),
        50026 => "Group".to_string(),
        50027 => "Thumb".to_string(),
        50028 => "DataGrid".to_string(),
        50029 => "DataItem".to_string(),
        50030 => "Document".to_string(),
        50031 => "SplitButton".to_string(),
        50032 => "Window".to_string(),
        50033 => "Pane".to_string(),
        50034 => "Header".to_string(),
        50035 => "HeaderItem".to_string(),
        50036 => "Table".to_string(),
        50037 => "TitleBar".to_string(),
        50038 => "Separator".to_string(),
        _ => format!("Unknown({})", id),
    }
}

#[cfg(not(windows))]
pub fn capture_context(reason: &str) -> AppContext {
    AppContext {
        reason: reason.to_string(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    }
}

#[cfg(not(windows))]
pub fn capture_foreground_monitor() -> Option<MonitorBounds> {
    None
}

// ─── Win32 helpers ───

#[cfg(windows)]
pub unsafe fn read_window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut buf);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

#[cfg(windows)]
pub unsafe fn read_class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

/// pid → 可执行文件名（不含路径）。inject 模块用它指认「是谁占着剪贴板」。
#[cfg(windows)]
pub(crate) fn get_process_name(pid: u32) -> String {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => {
                let name = get_process_image_name(h);
                let _ = CloseHandle(h);
                name.rsplit('\\').next().unwrap_or("").to_string()
            }
            Err(_) => String::new(),
        }
    }
}

#[cfg(windows)]
fn get_process_path(pid: u32) -> String {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => {
                let path = get_process_image_name(h);
                let _ = CloseHandle(h);
                path
            }
            Err(_) => String::new(),
        }
    }
}

#[cfg(windows)]
unsafe fn get_process_image_name(handle: windows::Win32::Foundation::HANDLE) -> String {
    use windows::Win32::System::Threading::{PROCESS_NAME_FORMAT, QueryFullProcessImageNameW};
    let mut buf = [0u16; 1024];
    let mut size = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_FORMAT(0),
        windows::core::PWSTR(buf.as_mut_ptr()),
        &mut size,
    );
    if ok.is_ok() && size > 0 {
        String::from_utf16_lossy(&buf[..size as usize])
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_context_diag_serializes_codes_only() {
        let diag = text_diag("no_text_pattern", None, std::time::Instant::now());
        let json = serde_json::to_value(&diag).unwrap();
        let obj = json.as_object().unwrap();
        assert_eq!(
            obj.get("result").and_then(|value| value.as_str()),
            Some("no_text_pattern")
        );
        assert!(obj.contains_key("elapsedMs"));
        assert!(!obj.contains_key("depth"));
        assert_eq!(obj.len(), 2);

        let captured =
            serde_json::to_value(text_diag("captured", Some(2), std::time::Instant::now()))
                .unwrap();
        assert_eq!(
            captured.get("depth").and_then(|value| value.as_u64()),
            Some(2)
        );
    }

    #[test]
    fn app_context_omits_diag_unless_text_was_requested() {
        let json = serde_json::to_value(AppContext::default()).unwrap();
        assert!(json.get("textContextDiag").is_none());

        let requested = AppContext {
            text_context_diag: Some(text_diag("captured", Some(1), std::time::Instant::now())),
            ..Default::default()
        };
        let json = serde_json::to_value(requested).unwrap();
        assert!(json.get("textContextDiag").is_some());
    }

    #[cfg(windows)]
    #[test]
    fn text_context_failure_policy_prefers_empty_and_distinguishes_no_pattern() {
        assert_eq!(
            note_text_context_failure(None, "no_caret"),
            Some("no_caret")
        );
        assert_eq!(
            note_text_context_failure(Some("no_caret"), "empty"),
            Some("empty")
        );
        assert_eq!(
            note_text_context_failure(Some("empty"), "no_caret"),
            Some("empty")
        );

        assert_eq!(text_context_failure_reason(Some("empty"), true), "empty");
        assert_eq!(
            text_context_failure_reason(Some("no_caret"), true),
            "no_caret"
        );
        assert_eq!(text_context_failure_reason(None, true), "empty");
        assert_eq!(text_context_failure_reason(None, false), "no_text_pattern");
    }

    #[cfg(windows)]
    #[test]
    fn cast_failure_still_uses_text_pattern_on_the_same_element() {
        let context = TextContext {
            source: "text_pattern".to_string(),
            ..Default::default()
        };
        let (captured, failure) = choose_text_pattern_outcome(
            TextPatternOutcome::Failed("text_pattern2_cast_failed"),
            TextPatternOutcome::Captured(context),
        );
        assert_eq!(
            captured.as_ref().map(|value| value.source.as_str()),
            Some("text_pattern")
        );
        assert!(failure.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn cast_failure_is_reported_only_when_no_layer_captures() {
        let (captured, failure) = choose_text_pattern_outcome(
            TextPatternOutcome::Failed("text_pattern2_cast_failed"),
            TextPatternOutcome::Unavailable,
        );
        assert!(captured.is_none());
        assert_eq!(failure, Some("text_pattern2_cast_failed"));
        assert_eq!(
            text_context_failure_reason(failure, false),
            "text_pattern2_cast_failed"
        );
    }

    #[cfg(windows)]
    #[test]
    fn empty_wins_over_a_caret_failure_across_patterns() {
        let (captured, failure) = choose_text_pattern_outcome(
            TextPatternOutcome::Failed("no_caret"),
            TextPatternOutcome::Failed("empty"),
        );
        assert!(captured.is_none());
        assert_eq!(failure, Some("empty"));
    }
}
