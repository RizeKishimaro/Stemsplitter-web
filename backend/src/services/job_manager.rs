use std::{sync::Arc, time::Duration};

use serde::Serialize;
use sqlx::PgPool;
use tokio::{task::JoinSet, time};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{error::AppError, models::job::ProcessingJob};

#[derive(Clone, Debug, Serialize)]
pub struct JobEvent {
    pub job_id: Uuid,
    pub status: String,
    pub progress: f64,
    pub message: Option<String>,
}

pub struct JobManager {
    db: PgPool,
    events: tokio::sync::broadcast::Sender<JobEvent>,
    poll_interval: Duration,
    concurrency: usize,
}

impl JobManager {
    pub fn new(
        db: PgPool,
        events: tokio::sync::broadcast::Sender<JobEvent>,
        poll_interval: Duration,
        concurrency: usize,
    ) -> Self {
        Self {
            db,
            events,
            poll_interval,
            concurrency: concurrency.max(1),
        }
    }

    /// Interrupted jobs are safe to retry only while processing has no external
    /// side effects. The future SCNet executor must write outputs atomically.
    pub async fn recover_interrupted(&self) -> Result<u64, AppError> {
        let result = sqlx::query("UPDATE processing_jobs SET status = 'QUEUED', cancel_requested = false, error_message = 'Worker interrupted; queued for retry on startup', updated_at = now() WHERE status = 'RUNNING'")
            .execute(&self.db).await?;
        Ok(result.rows_affected())
    }

    pub async fn cancel(&self, job_id: Uuid) -> Result<ProcessingJob, AppError> {
        let job = sqlx::query_as::<_, ProcessingJob>(
            "UPDATE processing_jobs SET status = 'CANCELLED', cancel_requested = true, finished_at = now(), updated_at = now() WHERE id = $1 AND status IN ('QUEUED', 'RUNNING') RETURNING *",
        ).bind(job_id).fetch_optional(&self.db).await?.ok_or(AppError::NotFound)?;
        self.emit(&job, Some("Cancelled by request".into()));
        Ok(job)
    }

    pub async fn run(self: Arc<Self>, shutdown: CancellationToken) {
        let mut workers = JoinSet::new();
        for worker_id in 0..self.concurrency {
            let manager = self.clone();
            let stop = shutdown.clone();
            workers.spawn(async move {
                manager.worker(worker_id, stop).await;
            });
        }
        shutdown.cancelled().await;
        workers.abort_all();
        while workers.join_next().await.is_some() {}
    }

    async fn worker(self: Arc<Self>, worker_id: usize, shutdown: CancellationToken) {
        let mut interval = time::interval(self.poll_interval);
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = interval.tick() => {
                    match self.claim().await {
                        Ok(Some(job)) => self.execute(job).await,
                        Ok(None) => {},
                        Err(error) => tracing::error!(worker_id, error = %error, "job polling failed"),
                    }
                }
            }
        }
    }

    async fn claim(&self) -> Result<Option<ProcessingJob>, sqlx::Error> {
        let mut tx = self.db.begin().await?;
        let next = sqlx::query_scalar::<_, Uuid>("SELECT id FROM processing_jobs WHERE status = 'QUEUED' AND NOT cancel_requested ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED")
            .fetch_optional(&mut *tx).await?;
        let Some(id) = next else {
            tx.commit().await?;
            return Ok(None);
        };
        let job = sqlx::query_as::<_, ProcessingJob>("UPDATE processing_jobs SET status = 'RUNNING', progress = 0, started_at = now(), updated_at = now(), error_message = NULL WHERE id = $1 AND status = 'QUEUED' RETURNING *")
            .bind(id).fetch_optional(&mut *tx).await?;
        tx.commit().await?;
        if let Some(job) = &job {
            self.emit(job, Some("Worker accepted job".into()));
        }
        Ok(job)
    }

    async fn execute(&self, job: ProcessingJob) {
        // This is an explicit migration seam, not fake audio processing. Jobs
        // remain durable and report why they cannot run until SCNet is ported.
        let message = "SCNet CPU executor is not configured; no audio was modified";
        let updated = sqlx::query_as::<_, ProcessingJob>("UPDATE processing_jobs SET status = 'FAILED', error_message = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'RUNNING' AND NOT cancel_requested RETURNING *")
            .bind(job.id).bind(message).fetch_optional(&self.db).await;
        match updated {
            Ok(Some(job)) => self.emit(&job, Some(message.into())),
            Ok(None) => {
                if let Ok(Some(cancelled)) = sqlx::query_as::<_, ProcessingJob>("UPDATE processing_jobs SET status = 'CANCELLED', cancel_requested = true, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'RUNNING' RETURNING *")
                    .bind(job.id).fetch_optional(&self.db).await {
                    self.emit(&cancelled, Some("Cancelled by request".into()));
                }
            }
            Err(error) => tracing::error!(job_id = %job.id, error = %error, "job completion persistence failed"),
        }
    }

    pub fn emit(&self, job: &ProcessingJob, message: Option<String>) {
        let _ = self.events.send(JobEvent {
            job_id: job.id,
            status: job.status.clone(),
            progress: job.progress,
            message,
        });
    }
}
