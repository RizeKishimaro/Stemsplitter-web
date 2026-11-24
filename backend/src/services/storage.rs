use std::path::{Path, PathBuf};

use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

pub async fn prepare_root(root: &Path) -> Result<(), std::io::Error> {
    fs::create_dir_all(root).await?;
    cleanup_incomplete(root).await
}

async fn cleanup_incomplete(directory: &Path) -> Result<(), std::io::Error> {
    let mut entries = fs::read_dir(directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let kind = entry.file_type().await?;
        if kind.is_dir() {
            Box::pin(cleanup_incomplete(&path)).await?;
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("uploading") {
            fs::remove_file(path).await?;
        }
    }
    Ok(())
}

pub fn safe_extension(filename: &str) -> Option<&'static str> {
    let extension = Path::new(filename)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    match extension.as_str() {
        "wav" | "wave" => Some("wav"),
        "mp3" => Some("mp3"),
        "flac" => Some("flac"),
        "ogg" | "oga" => Some("ogg"),
        "m4a" | "mp4" => Some("m4a"),
        "aac" => Some("aac"),
        _ => None,
    }
}

pub fn upload_path(root: &Path, project_id: Uuid, asset_id: Uuid, extension: &str) -> PathBuf {
    root.join(project_id.to_string())
        .join(format!("{asset_id}.{extension}"))
}

pub async fn write_chunk(file: &mut tokio::fs::File, bytes: &[u8]) -> Result<(), std::io::Error> {
    file.write_all(bytes).await
}

pub fn validate_upload_size(size: u64, maximum: u64) -> Result<(), ()> {
    if size > maximum { Err(()) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_validation_accepts_supported_audio_extensions_case_insensitively() {
        assert_eq!(safe_extension("mix.WAV"), Some("wav"));
        assert_eq!(safe_extension("audio.flac"), Some("flac"));
        assert_eq!(safe_extension("../unsafe.exe"), None);
        assert_eq!(safe_extension("no-extension"), None);
    }

    #[test]
    fn upload_validation_enforces_streamed_size_cap() {
        assert!(validate_upload_size(1024, 1024).is_ok());
        assert!(validate_upload_size(1025, 1024).is_err());
    }
}
