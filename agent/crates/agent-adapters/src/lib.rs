#![forbid(unsafe_code)]

pub mod cartesia_gemini;
mod noop;
mod synthetic;

pub use cartesia_gemini::{CartesiaGeminiBrain, CartesiaGeminiConfig};
pub use noop::NoopRealtimeBrain;
pub use synthetic::SyntheticBrain;
