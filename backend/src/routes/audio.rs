use std::path::Path;

use axum::{
    Json,
    extract::{Multipart, Path as AxumPath, State, rejection::MultipartRejection},
};
use serde::Serialize;
use sqlx::FromRow;
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

use crate::{
    error::AppError,
    models::audio_asset::{AudioAsset, AudioMetadata},
    services::storage,
    state::AppState,
};

#[derive(Serialize, FromRow)]
pub struct AudioListItem {
    pub id: Uuid,
    pub project_id: Uuid,
    pub original_filename: String,
    pub content_type: String,
    pub file_size_bytes: i64,
    pub sample_rate: i32,
    pub channels: i16,
    pub frame_count: i64,
    pub duration_seconds: f64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

pub async fn list_audio(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
) -> Result<Json<Vec<AudioListItem>>, AppError> {
    let project_id = Uuid::parse_str(&project_id)
        .map_err(|_| AppError::BadRequest("project_id must be a UUID".into()))?;
    let exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM projects WHERE id = $1)")
            .bind(project_id)
            .fetch_one(&state.db)
            .await?;
    if !exists {
        return Err(AppError::NotFound);
    }
    let rows = sqlx::query_as::<_, AudioListItem>("SELECT id, project_id, original_filename, content_type, file_size_bytes, sample_rate, channels, frame_count, duration_seconds, created_at, updated_at FROM audio_assets WHERE project_id = $1 ORDER BY created_at DESC")
        .bind(project_id).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

pub async fn upload_audio(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
    multipart: Result<Multipart, MultipartRejection>,
) -> Result<Json<AudioAsset>, AppError> {
    let project_id = Uuid::parse_str(&project_id)
        .map_err(|_| AppError::BadRequest("project_id must be a UUID".into()))?;
    let mut multipart =
        multipart.map_err(|_| AppError::BadRequest("Malformed multipart upload".into()))?;
    let exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM projects WHERE id = $1)")
            .bind(project_id)
            .fetch_one(&state.db)
            .await?;
    if !exists {
        return Err(AppError::NotFound);
    }
    let mut filename: Option<String> = None;
    let mut content_type = String::from("application/octet-stream");
    let mut metadata: Option<AudioMetadata> = None;
    let mut file_path = None;
    let mut destination_path = None;
    let mut asset_id = None;
    let mut file_size: u64 = 0;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::BadRequest("Malformed multipart upload".into()))?
    {
        match field.name().unwrap_or("").to_owned().as_str() {
            "file" => {
                if filename.is_some() {
                    return Err(AppError::BadRequest(
                        "Only one audio file may be uploaded".into(),
                    ));
                }
                let raw_name = field.file_name().unwrap_or("audio").to_owned();
                let name = Path::new(&raw_name)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("audio")
                    .chars()
                    .filter(|character| !character.is_control())
                    .take(240)
                    .collect::<String>();
                let extension = storage::safe_extension(&name).ok_or_else(|| {
                    AppError::BadRequest(
                        "Supported file formats are WAV, MP3, FLAC, OGG, M4A, and AAC".into(),
                    )
                })?;
                content_type = field
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_owned();
                if !content_type.starts_with("audio/")
                    && content_type != "application/octet-stream"
                    && content_type != "video/mp4"
                {
                    return Err(AppError::BadRequest(
                        "The uploaded file must have an audio content type".into(),
                    ));
                }
                let new_asset_id = Uuid::new_v4();
                let directory = state.config.upload_dir.join(project_id.to_string());
                fs::create_dir_all(&directory).await?;
                let final_path = storage::upload_path(
                    &state.config.upload_dir,
                    project_id,
                    new_asset_id,
                    extension,
                );
                let temporary_path = final_path.with_extension(format!("{extension}.uploading"));
                let mut output = fs::File::create(&temporary_path).await?;
                let mut field = field;
                while let Some(chunk) = field
                    .chunk()
                    .await
                    .map_err(|_| AppError::BadRequest("Malformed audio stream".into()))?
                {
                    file_size = file_size.saturating_add(chunk.len() as u64);
                    if storage::validate_upload_size(
                        file_size,
                        state.config.max_upload_bytes as u64,
                    )
                    .is_err()
                    {
                        drop(output);
                        let _ = fs::remove_file(&temporary_path).await;
                        return Err(AppError::PayloadTooLarge);
                    }
                    storage::write_chunk(&mut output, &chunk).await?;
                }
                output.flush().await?;
                output.sync_all().await?;
                drop(output);
                if file_size == 0 {
                    let _ = fs::remove_file(&temporary_path).await;
                    return Err(AppError::BadRequest("Audio file is empty".into()));
                }
                filename = Some(name);
                file_path = Some(temporary_path);
                destination_path = Some(final_path);
                asset_id = Some(new_asset_id);
            }
            "sample_rate" | "channels" | "frame_count" => {
                let key = field.name().unwrap_or("").to_owned();
                let value = field
                    .text()
                    .await
                    .map_err(|_| AppError::BadRequest(format!("Invalid {key}")))?;
                let mut current = metadata.unwrap_or(AudioMetadata {
                    sample_rate: 0,
                    channels: 0,
                    frame_count: 0,
                });
                match key.as_str() {
                    "sample_rate" => {
                        current.sample_rate = value.parse().map_err(|_| {
                            AppError::BadRequest("sample_rate must be an integer".into())
                        })?
                    }
                    "channels" => {
                        current.channels = value.parse().map_err(|_| {
                            AppError::BadRequest("channels must be an integer".into())
                        })?
                    }
                    "frame_count" => {
                        current.frame_count = value.parse().map_err(|_| {
                            AppError::BadRequest("frame_count must be an integer".into())
                        })?
                    }
                    _ => unreachable!(),
                }
                metadata = Some(current);
            }
            _ => return Err(AppError::BadRequest("Unexpected multipart field".into())),
        }
    }

    let Some(path) = file_path else {
        return Err(AppError::BadRequest("The file field is required".into()));
    };
    let Some(filename) = filename else {
        return Err(AppError::BadRequest("The file field is required".into()));
    };
    let Some(metadata) = metadata else {
        let _ = fs::remove_file(&path).await;
        return Err(AppError::BadRequest(
            "sample_rate, channels, and frame_count are required".into(),
        ));
    };
    let validated = match metadata.validate() {
        Ok(metadata) => metadata,
        Err(message) => {
            let _ = fs::remove_file(&path).await;
            return Err(AppError::BadRequest(message.into()));
        }
    };
    let file_size_bytes = match i64::try_from(file_size) {
        Ok(size) => size,
        Err(_) => {
            let _ = fs::remove_file(&path).await;
            return Err(AppError::PayloadTooLarge);
        }
    };
    let destination_path = destination_path
        .ok_or_else(|| AppError::BadRequest("The file field is required".into()))?;
    let asset_id =
        asset_id.ok_or_else(|| AppError::BadRequest("The file field is required".into()))?;
    fs::rename(&path, &destination_path).await?;
    let result = sqlx::query_as::<_, AudioAsset>("INSERT INTO audio_assets (id, project_id, original_filename, content_type, stored_path, file_size_bytes, sample_rate, channels, frame_count, duration_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, project_id, original_filename, content_type, stored_path, file_size_bytes, sample_rate, channels, frame_count, duration_seconds, created_at, updated_at")
        .bind(asset_id)
        .bind(project_id).bind(filename).bind(content_type).bind(destination_path.to_string_lossy().to_string())
        .bind(file_size_bytes)
        .bind(validated.sample_rate as i32).bind(validated.channels as i16).bind(validated.frame_count as i64)
        .bind(validated.duration_seconds()).fetch_one(&state.db).await;
    match result {
        Ok(asset) => Ok(Json(asset)),
        Err(error) => {
            let _ = fs::remove_file(&destination_path).await;
            Err(AppError::Database(error))
        }
    }
}
