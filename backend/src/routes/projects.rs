use axum::{
    Json,
    extract::{Path, State, rejection::JsonRejection},
};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    error::AppError,
    models::{
        audio_asset::AudioAsset,
        job::ProcessingJob,
        project::{CreateProject, Project},
    },
    state::AppState,
};

#[derive(Serialize)]
pub struct ProjectDetails {
    project: Project,
    audio_assets: Vec<AudioAsset>,
    jobs: Vec<ProcessingJob>,
}

pub async fn create_project(
    State(state): State<AppState>,
    body: Result<Json<CreateProject>, JsonRejection>,
) -> Result<Json<Project>, AppError> {
    let Json(input) = body.map_err(|_| AppError::BadRequest("Invalid JSON request body".into()))?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(AppError::BadRequest(
            "name must contain 1 to 200 characters".into(),
        ));
    }
    if input
        .description
        .as_ref()
        .is_some_and(|value| value.len() > 10_000)
    {
        return Err(AppError::BadRequest(
            "description must be at most 10000 bytes".into(),
        ));
    }
    let project = sqlx::query_as::<_, Project>("INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id, name, description, created_at, updated_at")
        .bind(name).bind(input.description.map(|value| value.trim().to_owned())).fetch_one(&state.db).await?;
    Ok(Json(project))
}

pub async fn get_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<ProjectDetails>, AppError> {
    let project_id = Uuid::parse_str(&project_id)
        .map_err(|_| AppError::BadRequest("project_id must be a UUID".into()))?;
    let project = sqlx::query_as::<_, Project>(
        "SELECT id, name, description, created_at, updated_at FROM projects WHERE id = $1",
    )
    .bind(project_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let audio_assets = sqlx::query_as::<_, AudioAsset>("SELECT id, project_id, original_filename, content_type, stored_path, file_size_bytes, sample_rate, channels, frame_count, duration_seconds, created_at, updated_at FROM audio_assets WHERE project_id = $1 ORDER BY created_at")
        .bind(project_id).fetch_all(&state.db).await?;
    let jobs = sqlx::query_as::<_, ProcessingJob>(
        "SELECT * FROM processing_jobs WHERE project_id = $1 ORDER BY created_at DESC",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await?;
    let _timing_contract: Value = serde_json::json!({ "authoritative_units": "integer_samples" });
    Ok(Json(ProjectDetails {
        project,
        audio_assets,
        jobs,
    }))
}
