use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, FromRow)]
pub struct AudioAsset {
    pub id: Uuid,
    pub project_id: Uuid,
    pub original_filename: String,
    pub content_type: String,
    #[serde(skip_serializing)]
    pub stored_path: String,
    pub file_size_bytes: i64,
    pub sample_rate: i32,
    pub channels: i16,
    pub frame_count: i64,
    pub duration_seconds: f64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioMetadata {
    pub sample_rate: u32,
    pub channels: u16,
    pub frame_count: u64,
}

impl AudioMetadata {
    pub fn validate(self) -> Result<Self, &'static str> {
        if !(8_000..=384_000).contains(&self.sample_rate) {
            return Err("sample_rate must be between 8000 and 384000 Hz");
        }
        if !(1..=32).contains(&self.channels) {
            return Err("channels must be between 1 and 32");
        }
        if self.frame_count == 0 || self.frame_count > i64::MAX as u64 {
            return Err("frame_count must be a positive supported sample count");
        }
        Ok(self)
    }

    pub fn duration_seconds(self) -> f64 {
        self.frame_count as f64 / f64::from(self.sample_rate)
    }
}

/// All timing is authoritative in integer source samples. Seconds are derived.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct SampleRange {
    pub start_sample: u64,
    pub end_sample: u64,
    pub process_start_sample: u64,
    pub process_end_sample: u64,
    pub trim_start_sample: u64,
    pub trim_end_sample: u64,
}

impl SampleRange {
    pub fn validate(&self, source_frames: u64) -> Result<(), &'static str> {
        if self.start_sample >= self.end_sample || self.end_sample > source_frames {
            return Err("section core sample range is invalid");
        }
        if self.process_start_sample > self.start_sample
            || self.process_end_sample < self.end_sample
            || self.process_end_sample > source_frames
            || self.process_start_sample >= self.process_end_sample
        {
            return Err("processing sample range must contain the exact core range");
        }
        if self.trim_start_sample != self.start_sample - self.process_start_sample
            || self.trim_end_sample != self.process_end_sample - self.end_sample
        {
            return Err("trim offsets must preserve the exact core sample positions");
        }
        Ok(())
    }
}

pub fn sample_to_seconds(sample: u64, sample_rate: u32) -> Result<f64, &'static str> {
    if sample_rate == 0 {
        return Err("sample_rate must be positive");
    }
    Ok(sample as f64 / f64::from(sample_rate))
}

#[cfg(test)]
mod tests {
    use super::{AudioMetadata, SampleRange, sample_to_seconds};

    #[test]
    fn sample_positions_convert_to_time_without_boundary_rounding() {
        assert_eq!(sample_to_seconds(48_000, 48_000).unwrap(), 1.0);
        assert_eq!(sample_to_seconds(24_000, 48_000).unwrap(), 0.5);
        assert_eq!(sample_to_seconds(1, 0), Err("sample_rate must be positive"));
    }

    #[test]
    fn rejects_invalid_audio_metadata() {
        assert!(
            AudioMetadata {
                sample_rate: 0,
                channels: 2,
                frame_count: 1
            }
            .validate()
            .is_err()
        );
        assert!(
            AudioMetadata {
                sample_rate: 48_000,
                channels: 0,
                frame_count: 1
            }
            .validate()
            .is_err()
        );
        assert!(
            AudioMetadata {
                sample_rate: 48_000,
                channels: 2,
                frame_count: 0
            }
            .validate()
            .is_err()
        );
        assert_eq!(
            AudioMetadata {
                sample_rate: 48_000,
                channels: 2,
                frame_count: 96_000
            }
            .validate()
            .unwrap()
            .duration_seconds(),
            2.0
        );
    }

    #[test]
    fn section_sample_ranges_preserve_core_and_processing_overlap() {
        let range = SampleRange {
            start_sample: 100,
            end_sample: 900,
            process_start_sample: 0,
            process_end_sample: 1000,
            trim_start_sample: 100,
            trim_end_sample: 100,
        };
        assert!(range.validate(1000).is_ok());
        let invalid = SampleRange {
            trim_start_sample: 99,
            ..range
        };
        assert!(invalid.validate(1000).is_err());
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct OutputTiming {
    pub output_sample_rate: u32,
    pub output_frame_count: u64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct StemSourceMapping {
    pub stem: String,
    pub source_audio_asset_id: uuid::Uuid,
    pub source_start_sample: u64,
    pub source_end_sample: u64,
    pub output_start_sample: u64,
    pub output_end_sample: u64,
    /// Offset only when measured from produced output; never fill from guesswork.
    pub measured_processing_offset_samples: Option<i64>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct InferenceTimingManifest {
    pub original_sample_rate: u32,
    pub original_frame_count: u64,
    pub sections: Vec<SampleRange>,
    pub output: Option<OutputTiming>,
    pub stems: Vec<StemSourceMapping>,
}
