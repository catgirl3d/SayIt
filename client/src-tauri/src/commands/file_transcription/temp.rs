use std::fs;
use std::path::{Path, PathBuf};

pub(super) fn create_job_temp_dir(job_id: &str) -> Result<PathBuf, String> {
    let directory = std::env::temp_dir().join(format!("sayit-file-{job_id}"));
    fs::create_dir(&directory).map_err(|error| {
        format!(
            "Failed to create the private temporary audio directory {}: {error}",
            directory.display()
        )
    })?;
    Ok(directory)
}

/// Removes `sayit-file-*` directories left behind when a previous run crashed before
/// the worker could clean up its decoded audio. Current directories are left alone by
/// the age check so a concurrent instance can never lose its working files.
pub fn cleanup_stale_temp_directories() {
    cleanup_stale_temp_directories_older_than(
        &std::env::temp_dir(),
        std::time::Duration::from_secs(24 * 60 * 60),
    );
}

fn cleanup_stale_temp_directories_older_than(root: &Path, max_age: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let Some(cutoff) = std::time::SystemTime::now().checked_sub(max_age) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("sayit-file-")
        {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified >= cutoff {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(entry.path()) {
            log::warn!(
                "Failed to remove stale file transcription temp directory {}: {error}",
                entry.path().display()
            );
        }
    }
}

pub(super) fn cleanup_temp_directory(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove temporary decoded audio: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::file_transcription::test_support::test_dir;

    #[test]
    fn cancelled_job_cleanup_removes_only_its_owned_temp_directory() {
        let dir = test_dir("cancel-cleanup");
        std::fs::write(dir.join("decoded.pcm"), b"owned").unwrap();
        cleanup_temp_directory(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn stale_temp_sweep_removes_only_aged_job_directories() {
        let root = test_dir("sweep-root");
        let aged = root.join("sayit-file-aged");
        std::fs::create_dir_all(&aged).unwrap();
        std::fs::write(aged.join("decoded.pcm"), b"pcm").unwrap();
        let foreign = root.join("sayit-foreign");
        std::fs::create_dir_all(&foreign).unwrap();

        cleanup_stale_temp_directories_older_than(
            &root,
            std::time::Duration::from_secs(365 * 24 * 60 * 60),
        );
        assert!(
            aged.exists(),
            "a fresh job directory must survive the sweep"
        );
        assert!(foreign.exists());

        cleanup_stale_temp_directories_older_than(&root, std::time::Duration::ZERO);
        assert!(!aged.exists(), "an aged job directory must be swept");
        assert!(
            foreign.exists(),
            "directories outside the sayit-file prefix must survive"
        );
        std::fs::remove_dir_all(root).ok();
    }
}
