pub mod audio;
pub mod health;
pub mod jobs;
pub mod projects;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use tower_http::trace::TraceLayer;

use crate::{services::job_manager::JobEvent, state::AppState};

pub fn router(state: AppState, max_upload_bytes: usize) -> Router {
    let upload_limit = max_upload_bytes.saturating_add(128 * 1024);
    Router::new()
        .route("/health", get(health::health))
        .route("/projects", post(projects::create_project))
        .route("/projects/{project_id}", get(projects::get_project))
        .route(
            "/projects/{project_id}/audio",
            post(audio::upload_audio)
                .get(audio::list_audio)
                .layer(DefaultBodyLimit::max(upload_limit)),
        )
        .route("/projects/{project_id}/jobs", post(jobs::create_job))
        .route("/jobs/{job_id}", get(jobs::get_job))
        .route("/jobs/{job_id}/cancel", post(jobs::cancel_job))
        .route("/jobs/{job_id}/events", get(jobs::job_events))
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}

pub fn event_channel() -> tokio::sync::broadcast::Sender<JobEvent> {
    let (sender, _) = tokio::sync::broadcast::channel(256);
    sender
}
