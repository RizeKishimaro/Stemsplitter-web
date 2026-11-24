use std::{env, net::SocketAddr, path::PathBuf, str::FromStr, time::Duration};

#[derive(Clone, Debug)]
pub struct Config {
    pub address: SocketAddr,
    pub database_url: String,
    pub database_max_connections: u32,
    pub upload_dir: PathBuf,
    pub max_upload_bytes: usize,
    pub job_concurrency: usize,
    pub job_poll_interval: Duration,
    pub cors_allow_origins: Vec<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        dotenvy::dotenv().ok();
        let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port = value("PORT", 8787_u16)?;
        let address = SocketAddr::from_str(&format!("{host}:{port}"))
            .map_err(|error| format!("Invalid HOST/PORT: {error}"))?;
        let database_url =
            env::var("DATABASE_URL").map_err(|_| "DATABASE_URL must be set".to_string())?;
        if database_url.trim().is_empty() {
            return Err("DATABASE_URL must not be empty".into());
        }
        let max_upload_bytes = value("MAX_UPLOAD_BYTES", 1_073_741_824_usize)?;
        let job_concurrency = value("JOB_CONCURRENCY", 1_usize)?;
        if max_upload_bytes == 0 || job_concurrency == 0 {
            return Err("MAX_UPLOAD_BYTES and JOB_CONCURRENCY must be positive".into());
        }
        let poll_ms = value("JOB_POLL_INTERVAL_MS", 500_u64)?;
        if poll_ms == 0 {
            return Err("JOB_POLL_INTERVAL_MS must be positive".into());
        }
        let cors_allow_origins = env::var("CORS_ALLOW_ORIGINS")
            .unwrap_or_else(|_| "http://localhost:5173".into())
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .map(str::to_string)
            .collect();

        Ok(Self {
            address,
            database_url,
            database_max_connections: value("DATABASE_MAX_CONNECTIONS", 10_u32)?,
            upload_dir: PathBuf::from(
                env::var("UPLOAD_DIR").unwrap_or_else(|_| "./data/uploads".into()),
            ),
            max_upload_bytes,
            job_concurrency,
            job_poll_interval: Duration::from_millis(poll_ms),
            cors_allow_origins,
        })
    }
}

fn value<T: FromStr>(key: &str, default: T) -> Result<T, String> {
    match env::var(key) {
        Ok(value) => value
            .parse()
            .map_err(|_| format!("{key} has an invalid value")),
        Err(_) => Ok(default),
    }
}
