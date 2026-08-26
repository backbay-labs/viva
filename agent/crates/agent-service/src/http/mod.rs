//! `SERVICE-017`: the three HTTP responsibility groups, merged once each.
//!
//! No business logic lives here. `app.rs` adds `/ws` and the shared state.

use axum::Router;

use crate::app::AppState;

pub(crate) mod health;
pub(crate) mod ingestion;
pub(crate) mod library;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .merge(health::routes())
        .merge(ingestion::routes())
        .merge(library::routes())
}
