use super::pcm::{CHANNELS, SAMPLE_BYTES, SAMPLE_RATE};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const TOOL_SCAN_MAX_DEPTH: u8 = 3;
const TOOL_SCAN_MAX_ENTRIES_PER_DIRECTORY: usize = 256;
pub(super) const STDERR_CAPTURE_LIMIT: usize = 256 * 1024;

#[derive(Clone)]
pub(super) struct ToolPaths {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

#[derive(Clone, Debug)]
struct ScanCandidate {
    path: PathBuf,
    max_depth: u8,
    bin_style_only: bool,
}

impl ScanCandidate {
    fn direct(path: PathBuf) -> Self {
        Self {
            path,
            max_depth: 0,
            bin_style_only: false,
        }
    }

    fn recursive(path: PathBuf, max_depth: u8, bin_style_only: bool) -> Self {
        Self {
            path,
            max_depth,
            bin_style_only,
        }
    }
}

fn absolute_candidate(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(&path))
            .unwrap_or(path)
    }
}

fn program_candidates(directory: Option<&Path>, name: &str) -> Vec<PathBuf> {
    let names = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    match directory {
        Some(directory) => names
            .into_iter()
            .map(|candidate| absolute_candidate(directory.join(candidate)))
            .collect(),
        None => std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .flat_map(|directory| {
                names
                    .iter()
                    .map(move |name| absolute_candidate(directory.join(name)))
            })
            .collect(),
    }
}

fn resolve_program(directory: Option<&Path>, name: &str) -> Result<PathBuf, String> {
    program_candidates(directory, name)
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            if directory.is_some() {
                format!(
                    "{name} was not found in the selected FFmpeg folder. Install FFmpeg and select the folder containing ffmpeg and ffprobe."
                )
            } else {
                format!(
                    "{name} was not found on PATH. Install FFmpeg and add its bin folder to PATH, or select that folder in SayIt."
                )
            }
        })
}

pub(super) fn resolve_tools(directory: Option<&str>) -> Result<ToolPaths, String> {
    let directory = directory
        .map(str::trim)
        .filter(|directory| !directory.is_empty())
        .map(PathBuf::from);
    if let Some(directory) = directory.as_ref() {
        if !directory.is_dir() {
            return Err(format!(
                "The selected FFmpeg path is not a directory: {}",
                directory.display()
            ));
        }
    }
    Ok(ToolPaths {
        ffmpeg: resolve_program(directory.as_deref(), "ffmpeg")?,
        ffprobe: resolve_program(directory.as_deref(), "ffprobe")?,
    })
}

/// Both media tools may only open local files and pipes: the whitelist keeps a crafted
/// container from making the demuxer resolve network protocols on its own.
fn restrict_input_protocols(command: &mut Command) {
    command.args(["-protocol_whitelist", "file,pipe"]);
}

pub(super) fn ffprobe_command(tools: &ToolPaths, source: &Path) -> Command {
    let mut command = Command::new(&tools.ffprobe);
    // These ffprobe builds do not define -nostdin; cmdutils consumes the next token as its value.
    command.args(["-v", "error"]);
    restrict_input_protocols(&mut command);
    command.args(["-show_streams", "-show_format", "-of", "json", "-i"]);
    command.arg(source);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}

pub(super) fn ffmpeg_command(tools: &ToolPaths, source: &Path, audio_track: usize) -> Command {
    let mut command = Command::new(&tools.ffmpeg);
    command.args(["-nostdin", "-nostats", "-progress", "pipe:2", "-v", "error"]);
    restrict_input_protocols(&mut command);
    command.args(["-i"]);
    let pcm_format = format!("s{}le", SAMPLE_BYTES * 8);
    let pcm_codec = format!("pcm_{pcm_format}");
    let channels = CHANNELS.to_string();
    let sample_rate = SAMPLE_RATE.to_string();
    command
        .arg(source)
        .args(["-map", &format!("0:a:{audio_track}"), "-vn", "-sn", "-dn"])
        .args([
            "-f",
            pcm_format.as_str(),
            "-acodec",
            pcm_codec.as_str(),
            "-ac",
            channels.as_str(),
            "-ar",
            sample_rate.as_str(),
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn executable_name_matches(actual: &std::ffi::OsStr, stem: &str) -> bool {
    let actual = actual.to_string_lossy();
    actual.eq_ignore_ascii_case(stem) || actual.eq_ignore_ascii_case(&format!("{stem}.exe"))
}

fn find_tool_in_directory(directory: &Path, stem: &str) -> Option<PathBuf> {
    let mut entries = fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
    entries
        .into_iter()
        .find_map(|entry| executable_name_matches(&entry.file_name(), stem).then(|| entry.path()))
}

fn tool_directory_contains_both(directory: &Path) -> bool {
    find_tool_in_directory(directory, "ffmpeg").is_some()
        && find_tool_in_directory(directory, "ffprobe").is_some()
}

fn sorted_child_directories(directory: &Path) -> Vec<PathBuf> {
    let mut children = fs::read_dir(directory)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.take(TOOL_SCAN_MAX_ENTRIES_PER_DIRECTORY))
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|file_type| file_type.is_dir())
                .map(|_| entry.path())
        })
        .collect::<Vec<_>>();
    children.sort_by_key(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_ascii_lowercase())
    });
    children
}

fn is_bin_style_directory(path: &Path) -> bool {
    path.file_name()
        .map(|name| {
            name.to_string_lossy()
                .to_ascii_lowercase()
                .starts_with("bin")
        })
        .unwrap_or(false)
}

fn scan_candidate_root(candidate: &ScanCandidate) -> Option<PathBuf> {
    fn visit(directory: &Path, depth: u8, max_depth: u8, bin_style_only: bool) -> Option<PathBuf> {
        if !directory.is_dir() {
            return None;
        }
        let acceptable = !bin_style_only || (depth > 0 && is_bin_style_directory(directory));
        if acceptable && tool_directory_contains_both(directory) {
            return Some(directory.to_path_buf());
        }
        if depth >= max_depth {
            return None;
        }
        sorted_child_directories(directory)
            .into_iter()
            .find_map(|child| visit(&child, depth + 1, max_depth, bin_style_only))
    }

    visit(
        &candidate.path,
        0,
        candidate.max_depth,
        candidate.bin_style_only,
    )
}

/// Candidate roots are checked in declaration order: WinGet's package layout wins over
/// links, Chocolatey, Scoop, and fixed fallback directories when more than one is installed.
fn scan_candidate_roots(candidates: &[ScanCandidate]) -> Option<PathBuf> {
    candidates.iter().find_map(scan_candidate_root)
}

fn is_ffmpeg_package_directory(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    name.starts_with("gyan.ffmpeg") || name.contains("ffmpeg")
}

fn append_winget_package_candidates(
    packages_directory: &Path,
    candidates: &mut Vec<ScanCandidate>,
) {
    let mut packages = sorted_child_directories(packages_directory)
        .into_iter()
        .filter(|path| is_ffmpeg_package_directory(path))
        .collect::<Vec<_>>();
    packages.sort_by_key(|path| {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        (!name.starts_with("gyan.ffmpeg"), name)
    });
    candidates.extend(
        packages
            .into_iter()
            .map(|path| ScanCandidate::recursive(path, TOOL_SCAN_MAX_DEPTH, true)),
    );
}

#[cfg(test)]
fn scan_winget_packages(packages_directory: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    append_winget_package_candidates(packages_directory, &mut candidates);
    scan_candidate_roots(&candidates)
}

fn append_chocolatey_candidates(program_data: &Path, candidates: &mut Vec<ScanCandidate>) {
    candidates.push(ScanCandidate::direct(
        program_data.join("chocolatey").join("bin"),
    ));
    let library = program_data.join("chocolatey").join("lib");
    for package in sorted_child_directories(&library)
        .into_iter()
        .filter(|path| {
            path.file_name()
                .map(|name| {
                    name.to_string_lossy()
                        .to_ascii_lowercase()
                        .starts_with("ffmpeg")
                })
                .unwrap_or(false)
        })
    {
        candidates.push(ScanCandidate::recursive(
            package.join("tools"),
            TOOL_SCAN_MAX_DEPTH,
            false,
        ));
    }
}

fn default_ffmpeg_scan_candidates() -> Vec<ScanCandidate> {
    let mut candidates = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        append_winget_package_candidates(
            &local_app_data
                .join("Microsoft")
                .join("WinGet")
                .join("Packages"),
            &mut candidates,
        );
        candidates.push(ScanCandidate::direct(
            local_app_data
                .join("Microsoft")
                .join("WinGet")
                .join("Links"),
        ));
    }
    if let Some(program_data) = std::env::var_os("ProgramData").map(PathBuf::from) {
        append_chocolatey_candidates(&program_data, &mut candidates);
    }
    if let Some(user_profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        candidates.push(ScanCandidate::direct(
            user_profile.join("scoop").join("shims"),
        ));
        candidates.push(ScanCandidate::direct(
            user_profile
                .join("scoop")
                .join("apps")
                .join("ffmpeg")
                .join("current")
                .join("bin"),
        ));
    }
    candidates.extend([
        ScanCandidate::direct(PathBuf::from(r"C:\ffmpeg\bin")),
        ScanCandidate::direct(PathBuf::from(r"C:\Program Files\ffmpeg\bin")),
        ScanCandidate::direct(PathBuf::from(r"C:\Program Files (x86)\ffmpeg\bin")),
    ]);
    candidates
}

pub(super) fn detect_default_ffmpeg_directory() -> Option<PathBuf> {
    scan_candidate_roots(&default_ffmpeg_scan_candidates())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::file_transcription::test_support::test_dir;

    #[test]
    fn detects_winget_style_nested_layout_within_the_bounded_depth() {
        let root = test_dir("ffmpeg-detect-winget");
        let package = root.join("Gyan.FFmpeg_8.1.2");
        let bin = package.join("ffmpeg-8.1.2-full_build").join("bin1");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("ffmpeg.exe"), b"test").unwrap();
        std::fs::write(bin.join("ffprobe.exe"), b"test").unwrap();

        assert_eq!(scan_winget_packages(&root), Some(bin.clone()));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn detection_rejects_a_folder_that_contains_only_ffmpeg() {
        let directory = test_dir("ffmpeg-detect-incomplete");
        std::fs::write(directory.join("ffmpeg.exe"), b"test").unwrap();

        assert!(!tool_directory_contains_both(&directory));
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn detection_returns_none_when_no_candidate_contains_both_tools() {
        let root = test_dir("ffmpeg-detect-none");
        assert_eq!(
            scan_candidate_roots(&[ScanCandidate::direct(root.clone())]),
            None
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn detection_does_not_descend_beyond_the_configured_depth() {
        let root = test_dir("ffmpeg-detect-depth");
        let deep = root.join("one").join("two").join("three").join("four");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("ffmpeg.exe"), b"test").unwrap();
        std::fs::write(deep.join("ffprobe.exe"), b"test").unwrap();

        assert_eq!(
            scan_candidate_roots(&[ScanCandidate::recursive(root.clone(), 3, false)]),
            None
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn ffprobe_argv_omits_nostdin_and_keeps_protocol_whitelist_before_input() {
        let tools = ToolPaths {
            ffmpeg: PathBuf::from("ffmpeg.exe"),
            ffprobe: PathBuf::from("ffprobe.exe"),
        };
        let command = ffprobe_command(&tools, Path::new("sample.wav"));
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let protocol_index = args
            .iter()
            .position(|arg| arg == "-protocol_whitelist")
            .unwrap();
        let input_index = args.iter().position(|arg| arg == "-i").unwrap();

        assert_eq!(args[protocol_index + 1], "file,pipe");
        assert!(protocol_index < input_index);
        assert!(!args.iter().any(|arg| arg == "-nostdin"));
    }

    #[test]
    fn ffmpeg_argv_keeps_nostdin_for_the_gui_worker() {
        let tools = ToolPaths {
            ffmpeg: PathBuf::from("ffmpeg.exe"),
            ffprobe: PathBuf::from("ffprobe.exe"),
        };
        let command = ffmpeg_command(&tools, Path::new("sample.wav"), 0);
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args.iter().any(|arg| arg == "-nostdin"));
    }

    #[test]
    fn ffmpeg_output_matches_the_pcm_reader_contract() {
        use super::super::pcm::SAMPLE_RATE;

        let tools = ToolPaths {
            ffmpeg: PathBuf::from("ffmpeg.exe"),
            ffprobe: PathBuf::from("ffprobe.exe"),
        };
        let command = ffmpeg_command(&tools, Path::new("sample.wav"), 0);
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let values_after = |flag: &str| {
            args.iter()
                .enumerate()
                .filter(|(_, arg)| arg.as_str() == flag)
                .map(|(index, _)| args[index + 1].clone())
                .collect::<Vec<_>>()
        };

        // Literals pin the wire format; the rate is tied to the reader constant.
        assert_eq!(values_after("-f"), vec!["s16le".to_string()]);
        assert_eq!(values_after("-acodec"), vec!["pcm_s16le".to_string()]);
        assert_eq!(values_after("-ac"), vec!["1".to_string()]);
        assert_eq!(values_after("-ar"), vec![SAMPLE_RATE.to_string()]);
    }
}
