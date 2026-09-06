//! System display-language detection and `ui.language` preference support.
//!
//! The Rust-side resolver is necessary because the tray menu is created by Rust
//! during startup. It must use the correct language before the frontend is ready.
//!
//! `Win32_Globalization` is already enabled in the Cargo Windows feature list, so
//! the required API is available without adding a `sys-locale` dependency.
//!
//! Keep this separate from `commands/system.rs::get_system_locale()`: that command
//! uses `GetUserDefaultLocaleName` for regional formatting diagnostics, while this
//! module uses `GetUserDefaultUILanguage` for the Windows display language. The two
//! values can legitimately differ.

    /// Supported interface languages. Values match the frontend `Locale` type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Uk,
    En,
}

impl Lang {
    /// Frontend `Locale` tag and the only string representation exposed by this module.
    pub fn tag(self) -> &'static str {
        match self {
            Lang::Uk => "uk",
            Lang::En => "en",
        }
    }
}

/// Maps a Windows primary language ID (`PRIMARYLANGID`) to an interface language.
///
/// Ukrainian maps to Ukrainian; all other languages, including Chinese variants,
/// fall back to English because Chinese is not a supported interface language.
fn lang_from_primary_id(primary_id: u16) -> Lang {
    const LANG_UKRAINIAN: u16 = 0x22;

    match primary_id {
        LANG_UKRAINIAN => Lang::Uk,
        _ => Lang::En,
    }
}

#[cfg(not(windows))]
fn lang_from_locale_value(value: &str) -> Lang {
    let value = value.to_ascii_lowercase();
    if value.starts_with("zh") {
        Lang::En
    } else if value.starts_with("uk") {
        Lang::Uk
    } else {
        Lang::En
    }
}

/// Returns the system display language, falling back to English when unavailable.
#[cfg(windows)]
pub fn system_ui_lang() -> Lang {
    use windows::Win32::Globalization::GetUserDefaultUILanguage;

    let langid = unsafe { GetUserDefaultUILanguage() };
    if langid == 0 {
        return Lang::En;
    }
    lang_from_primary_id(langid & 0x03ff)
}

#[cfg(not(windows))]
pub fn system_ui_lang() -> Lang {
    // Non-Windows builds currently use this only for cargo test; the app targets Windows.
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|name| std::env::var(name).ok())
        .map_or(Lang::En, |value| lang_from_locale_value(&value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_primary_id_falls_back_to_english() {
        assert_eq!(lang_from_primary_id(0x04), Lang::En);
    }

    #[test]
    fn ukrainian_primary_id_maps_to_ukrainian() {
        assert_eq!(lang_from_primary_id(0x22), Lang::Uk);
    }

    #[test]
    fn other_primary_ids_map_to_english() {
        // 0x09 = English, 0x11 = Japanese, 0x12 = Korean, 0x07 = German.
        for id in [0x09, 0x11, 0x12, 0x07, 0x00] {
            assert_eq!(lang_from_primary_id(id), Lang::En, "primary_id={id:#x}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn locale_values_map_supported_languages() {
        assert_eq!(lang_from_locale_value("uk_UA.UTF-8"), Lang::Uk);
        assert_eq!(lang_from_locale_value("zh_CN.UTF-8"), Lang::En);
        assert_eq!(lang_from_locale_value("en_US.UTF-8"), Lang::En);
    }

    #[test]
    fn tags_match_frontend_locale_values() {
        assert_eq!(Lang::Uk.tag(), "uk");
        assert_eq!(Lang::En.tag(), "en");
    }
}
