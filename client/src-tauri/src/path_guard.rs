//! Path validation for file IPC commands.
//!
//! These commands take a path, or a record id that becomes a file name, from
//! the frontend. The frontend is ours, but it runs inside a webview: if a
//! malicious script ever gets in, it could otherwise use the commands to read,
//! write, or delete arbitrary local files. The Rust side therefore enforces
//! what each command is allowed to touch instead of trusting the frontend.

use std::path::{Path, PathBuf};

/// Recording id: the frontend generates `Date.now().toString(36)` plus a short
/// random base36 suffix, so ASCII letters and digits are enough. `_` and `-`
/// are accepted for future UUID-style ids.
///
/// The id is interpolated into a file name, so separators, dots, and an empty
/// value must never pass.
pub fn is_record_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// Whether the path is absolute and local to a disk. UNC, device, verbatim,
/// and drive-relative Windows paths are rejected before any filesystem call,
/// so a caller-controlled path cannot trigger SMB or device access just by
/// being resolved.
pub fn is_local_absolute_path(path: &Path) -> bool {
    #[cfg(windows)]
    {
        path.is_absolute()
            && matches!(
                path.components().next(),
                Some(std::path::Component::Prefix(prefix))
                    if matches!(prefix.kind(), std::path::Prefix::Disk(_))
            )
    }
    #[cfg(not(windows))]
    {
        path.is_absolute()
    }
}

/// Whether the path ends in one of the allowed extensions, ignoring case.
pub fn has_extension(path: &Path, allowed: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            allowed
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(extension))
        })
}

/// Returns the real path of an existing regular file that is a direct child of
/// `dir`.
///
/// Both sides are canonicalized, so `..`, symlinks, junctions, and case
/// differences resolve to the same real path before the comparison. A path
/// outside `dir`, a subdirectory, or a directory itself returns `None`.
pub fn existing_file_in_dir(path: &Path, dir: &Path) -> Option<PathBuf> {
    let file = std::fs::canonicalize(path).ok()?;
    let dir = std::fs::canonicalize(dir).ok()?;
    (file.is_file() && file.parent() == Some(dir.as_path())).then_some(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("sayit-path-guard-{}", uuid::Uuid::new_v4()))
    }

    #[cfg(windows)]
    #[test]
    fn local_absolute_paths_only() {
        assert!(is_local_absolute_path(Path::new(
            r"C:\Users\alina\audio\a.wav"
        )));
        assert!(!is_local_absolute_path(Path::new(
            r"\\?\C:\Users\alina\audio\a.wav"
        )));
        assert!(!is_local_absolute_path(Path::new(r"\\server\share\a.wav")));
        assert!(!is_local_absolute_path(Path::new(
            r"\\?\UNC\server\share\a.wav"
        )));
        assert!(!is_local_absolute_path(Path::new(r"\\.\pipe\a.wav")));
        assert!(!is_local_absolute_path(Path::new(r"C:a.wav")));
        assert!(!is_local_absolute_path(Path::new(r"\a.wav")));
        assert!(!is_local_absolute_path(Path::new("a.wav")));
    }

    #[cfg(unix)]
    #[test]
    fn local_absolute_paths_only_unix() {
        assert!(is_local_absolute_path(Path::new("/home/alina/audio/a.wav")));
        assert!(!is_local_absolute_path(Path::new("a.wav")));
        assert!(!is_local_absolute_path(Path::new("./a.wav")));
        assert!(!is_local_absolute_path(Path::new("../a.wav")));
    }

    #[test]
    fn record_ids() {
        assert!(is_record_id("mshhzwhhyxxw"));
        assert!(is_record_id("1b9d6bcd-bbfd-4b2d"));
        assert!(!is_record_id(""));
        assert!(!is_record_id("..\\x"));
        assert!(!is_record_id("../x"));
        assert!(!is_record_id("a/b"));
        assert!(!is_record_id("a.b"));
        assert!(!is_record_id("a b"));
    }

    #[test]
    fn files_outside_the_directory_are_rejected() {
        let root = temp_dir();
        let inner = root.join("audio");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("a.wav"), b"x").unwrap();
        fs::write(root.join("b.wav"), b"x").unwrap();

        assert!(existing_file_in_dir(&inner.join("a.wav"), &inner).is_some());
        assert!(existing_file_in_dir(&inner.join("..").join("b.wav"), &inner).is_none());
        assert!(existing_file_in_dir(&root.join("b.wav"), &inner).is_none());
        assert!(existing_file_in_dir(&inner.join("missing.wav"), &inner).is_none());
        assert!(existing_file_in_dir(&inner, &inner).is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extensions() {
        assert!(has_extension(Path::new("x.ZIP"), &["zip"]));
        assert!(!has_extension(Path::new("x.zip.exe"), &["zip"]));
        assert!(!has_extension(Path::new("x"), &["zip"]));
    }
}
