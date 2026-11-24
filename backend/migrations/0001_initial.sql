CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audio_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    original_filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    stored_path TEXT NOT NULL UNIQUE,
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
    sample_rate INTEGER NOT NULL CHECK (sample_rate BETWEEN 8000 AND 384000),
    channels SMALLINT NOT NULL CHECK (channels BETWEEN 1 AND 32),
    frame_count BIGINT NOT NULL CHECK (frame_count > 0),
    duration_seconds DOUBLE PRECISION NOT NULL CHECK (duration_seconds > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audio_assets_project_created_idx ON audio_assets(project_id, created_at DESC);

CREATE TABLE processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    audio_asset_id UUID NOT NULL REFERENCES audio_assets(id) ON DELETE RESTRICT,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    progress DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    error_message TEXT,
    cancel_requested BOOLEAN NOT NULL DEFAULT false,
    request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

CREATE INDEX processing_jobs_queue_idx ON processing_jobs(created_at) WHERE status = 'QUEUED';
CREATE INDEX processing_jobs_project_created_idx ON processing_jobs(project_id, created_at DESC);
