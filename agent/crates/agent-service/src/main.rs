use std::sync::Arc;

use agent_service::{build_brain, build_router, build_study_store, AppState, ServiceConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "agent_service=info,tower_http=info".into()),
        )
        .init();

    let config = ServiceConfig::from_env()?;
    let study_store = build_study_store(&config).await?;
    let brain = build_brain(&config, Arc::clone(&study_store));
    let state = AppState::with_study_store(
        brain,
        config.provider.as_str(),
        config.ws_access,
        config.max_sessions,
        study_store,
    )
    .with_trusted_user_id(config.trusted_user_id)
    .with_trusted_study_set_id(config.trusted_study_set_id)
    .with_trusted_session_id(config.trusted_session_id)
    .with_unauthenticated_paste_allowed(config.bind_addr.ip().is_loopback());
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "viva agent listening");
    axum::serve(listener, app).await?;
    Ok(())
}
