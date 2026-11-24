use axum::{
    Json,
    extract::{
        Path, State, WebSocketUpgrade,
        rejection::JsonRejection,
        ws::{Message, WebSocket},
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use uuid::Uuid;

use crate::{
    error::AppError,
    models::job::{CreateJob, ProcessingJob},
    state::AppState,
};

pub async fn create_job(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<CreateJob>, JsonRejection>,
) -> Result<(axum::http::StatusCode, Json<ProcessingJob>), AppError> {
    let project_id = Uuid::parse_str(&project_id)
        .map_err(|_| AppError::BadRequest("project_id must be a UUID".into()))?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("Invalid JSON request body".into()))?;
    if input.job_type != "separate" {
        return Err(AppError::BadRequest("job_type must be 'separate'".into()));
    }
    let asset = sqlx::query_as::<_, (Uuid, i32, i64)>(
        "SELECT project_id, sample_rate, frame_count FROM audio_assets WHERE id = $1",
    )
    .bind(input.audio_asset_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    if asset.0 != project_id {
        return Err(AppError::BadRequest(
            "audio asset does not belong to this project".into(),
        ));
    }
    let metadata = json!({
        "original_sample_rate": asset.1,
        "original_frame_count": asset.2,
        "timing_authority": "integer_sample_positions",
        "inference_executor": "scnet_cpu_not_yet_configured"
    });
    let job = sqlx::query_as::<_, ProcessingJob>("INSERT INTO processing_jobs (project_id, audio_asset_id, job_type, request_metadata) VALUES ($1,$2,$3,$4) RETURNING *")
        .bind(project_id).bind(input.audio_asset_id).bind(input.job_type).bind(metadata).fetch_one(&state.db).await?;
    state.jobs.emit(&job, Some("Queued".into()));
    Ok((axum::http::StatusCode::CREATED, Json(job)))
}

pub async fn get_job(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<Json<ProcessingJob>, AppError> {
    let job_id = Uuid::parse_str(&job_id)
        .map_err(|_| AppError::BadRequest("job_id must be a UUID".into()))?;
    let job = sqlx::query_as::<_, ProcessingJob>("SELECT * FROM processing_jobs WHERE id = $1")
        .bind(job_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(job))
}

pub async fn cancel_job(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<Json<ProcessingJob>, AppError> {
    let job_id = Uuid::parse_str(&job_id)
        .map_err(|_| AppError::BadRequest("job_id must be a UUID".into()))?;
    Ok(Json(state.jobs.cancel(job_id).await?))
}

pub async fn job_events(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, AppError> {
    let job_id = Uuid::parse_str(&job_id)
        .map_err(|_| AppError::BadRequest("job_id must be a UUID".into()))?;
    let exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM processing_jobs WHERE id = $1)")
            .bind(job_id)
            .fetch_one(&state.db)
            .await?;
    if !exists {
        return Err(AppError::NotFound);
    }
    Ok(upgrade.on_upgrade(move |socket| stream_events(socket, state, job_id)))
}

async fn stream_events(mut socket: WebSocket, state: AppState, job_id: Uuid) {
    let mut events = state.events.subscribe();
    if let Ok(Some(job)) =
        sqlx::query_as::<_, ProcessingJob>("SELECT * FROM processing_jobs WHERE id = $1")
            .bind(job_id)
            .fetch_optional(&state.db)
            .await
    {
        let initial = json!({ "job_id": job.id, "status": job.status, "progress": job.progress, "message": job.error_message });
        if socket
            .send(Message::Text(initial.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) if event.job_id == job_id => {
                    if socket.send(Message::Text(serde_json::to_string(&event).unwrap_or_default().into())).await.is_err() { break; }
                }
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            message = socket.next() => match message {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(Message::Ping(bytes))) => if socket.send(Message::Pong(bytes)).await.is_err() { break; },
                _ => {},
            }
        }
    }
}
