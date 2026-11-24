use std::sync::Arc;

use sqlx::PgPool;
use tokio::sync::broadcast;

use crate::{
    config::Config,
    services::job_manager::{JobEvent, JobManager},
};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub jobs: Arc<JobManager>,
    pub events: broadcast::Sender<JobEvent>,
}
