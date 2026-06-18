use std::sync::Arc;
use std::time::Duration;

use agent_service::{
    build_brain, build_router, build_study_store, AppState, ServiceConfig, VoiceDrainSignal,
    WsTimeouts,
};

const VOICE_DRAIN_GRACE_PERIOD: Duration = Duration::from_secs(2);

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
    .with_ws_timeouts(WsTimeouts {
        first_frame: WsTimeouts::default().first_frame,
        idle: config.max_turn_duration,
        session: config.max_session_duration,
    })
    .with_voice_limits(config.voice_limits)
    .with_unauthenticated_paste_allowed(config.bind_addr.ip().is_loopback());
    let drain_signal = state.drain_signal.clone();
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "viva agent listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(drain_signal))
        .await?;
    Ok(())
}

async fn shutdown_signal(drain_signal: VoiceDrainSignal) {
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        result = tokio::signal::ctrl_c() => {
            if let Err(error) = result {
                tracing::warn!(%error, "failed to listen for ctrl-c shutdown signal");
            }
        }
        _ = terminate => {}
    }

    tracing::info!("viva agent draining voice sessions before shutdown");
    drain_signal.begin_drain();
    tokio::time::sleep(VOICE_DRAIN_GRACE_PERIOD).await;
}
