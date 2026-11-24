# SonicLab Rust backend

This service is an independent API foundation for SonicLab 10.0. It does not replace or modify the React audio pipeline. It currently stores projects and audio metadata, streams uploaded files to disk, and persists separation job state in PostgreSQL. Separation jobs deliberately fail with an explicit message until the SCNet CPU executor is implemented; no inference or output stems are fabricated.

## Run locally

Install Rust and PostgreSQL, create an empty development database, copy `.env.example` to `.env`, set `DATABASE_URL`, then run `cargo run` from this directory. On startup the service applies the embedded SQLx migrations, creates the upload directory, removes incomplete `.uploading` files, and requeues jobs left in `RUNNING` state. Do not point development or tests at a production database. `cargo test` never reads `DATABASE_URL` or applies migrations.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind interface |
| `PORT` | `8787` | HTTP port |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `DATABASE_MAX_CONNECTIONS` | `10` | SQLx pool limit |
| `UPLOAD_DIR` | `./data/uploads` | Persistent audio file directory |
| `MAX_UPLOAD_BYTES` | `1073741824` | Maximum streamed upload size (1 GiB) |
| `JOB_CONCURRENCY` | `1` | Number of polling workers; keep at one on the 4-core / 6-GB target until benchmarked |
| `JOB_POLL_INTERVAL_MS` | `500` | Durable job queue poll interval |
| `CORS_ALLOW_ORIGINS` | `http://localhost:5173` | Comma-separated allowed browser origins |
| `RUST_LOG` | `soniclab_backend=info,tower_http=info` | Tracing filter |

`SONICLAB_TEST_DATABASE_URL` is an optional, separate URL used only by the explicit persistence integration test. The test wraps its insert/read in a transaction and rolls it back. It must reference a disposable test database with the migration already applied; the test itself does not run migrations.

## API v1

Errors use `{ "error": { "code": "...", "message": "..." } }`.

| Method and path | Behavior |
| --- | --- |
| `GET /api/v1/health` | Liveness response |
| `POST /api/v1/projects` | Create `{ "name": "...", "description": "..." }` |
| `GET /api/v1/projects/:project_id` | Project, audio metadata, and jobs |
| `POST /api/v1/projects/:project_id/audio` | Multipart upload: `file`, `sample_rate`, `channels`, `frame_count` |
| `GET /api/v1/projects/:project_id/audio` | List audio metadata |
| `POST /api/v1/projects/:project_id/jobs` | Create `{ "audio_asset_id": "uuid", "job_type": "separate" }` (201 Created) |
| `GET /api/v1/jobs/:job_id` | Read durable job state |
| `POST /api/v1/jobs/:job_id/cancel` | Cancel a queued or running job |
| `GET /api/v1/jobs/:job_id/events` | WebSocket; sends current state then matching progress events |

Upload size is bounded both at the HTTP body layer and while streaming chunks to a temporary file. Audio bytes are never buffered as a full upload or stored in PostgreSQL. The initial API accepts client-reported sample metadata and validates its numeric bounds; a production decoder must verify this metadata against the actual media before inference.

The queue is durable in PostgreSQL, not an in-memory work queue. Workers claim rows using `FOR UPDATE SKIP LOCKED`. Startup requeues interrupted `RUNNING` jobs because the current executor has no external side effects. Once inference/output writing exists, output files must be written atomically and recovery/idempotency rules must be revisited. WebSocket delivery is transient; clients can always reconnect and fetch the durable job resource.

## Timing and SCNet migration seam

`models::audio_asset::InferenceTimingManifest` defines the intended inference boundary. Integer source sample positions are authoritative. `SampleRange` carries exact section core bounds, expanded processing bounds (including overlap), and exact trim offsets back to the core. Seconds are derived from samples and sample rate. Output sample rate/frame count, each stem's source mapping, and measured processing offsets are represented explicitly; offsets remain absent until measured. Implementations must preserve the frontend's overlap/core-region trimming behavior and original sample coordinates, never independently round stem boundaries, stretch audio silently, or invent offsets.

The frontend's SCNet pipeline (`separation.worker.ts`, `separationScheduler.ts`, `separationPlan.ts`, and `chunkEngine.ts`) remains unchanged. Port and benchmark that same model/runtime and compare output timing before enabling the worker. Demucs is not substituted. This backend currently performs no cloud CPU separation.
