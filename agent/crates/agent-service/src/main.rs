use std::net::SocketAddr;
use std::sync::Arc;

use agent_service::{
    begin_drain_and_wait, build_brain, build_router, build_study_store,
    validate_runtime_store_preflight, AppState, DrainOutcome, ProjectionReadAccess, ServiceConfig,
};

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
    validate_runtime_store_preflight(&config, &study_store.capabilities())?;
    let brain = build_brain(&config, Arc::clone(&study_store));
    // `SERVICE-011`: the projection route exists only where both scoped credentials
    // are configured. A deployment missing either one serves no projection at all
    // rather than accepting a broader credential in their place.
    let projection_read_access = config
        .library_read_bearer
        .clone()
        .zip(config.ws_access.session_token_secret.clone())
        .map(|(library_read_bearer, session_token_secret)| {
            ProjectionReadAccess::new(
                library_read_bearer,
                session_token_secret,
                config.ws_access.allowed_origins.clone(),
            )
        });
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
    .with_operator_access(config.operator_access)
    .with_recorder_limits(config.recorder_limits)
    .with_trusted_proxies(config.trusted_proxies)
    .with_ws_timeouts(config.ws_timeouts)
    .with_turn_cap_override(config.max_turn_duration_overridden)
    .with_voice_limits(config.voice_limits)
    .with_failure_control(config.failure_control)
    .with_unauthenticated_paste_allowed(config.bind_addr.ip().is_loopback());
    let state = match projection_read_access {
        Some(access) => state.with_projection_read_access(access),
        None => state,
    };
    let shutdown_state = state.clone();
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "viva agent listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(shutdown_state))
    .await?;
    Ok(())
}

async fn shutdown_signal(state: AppState) {
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
    // `SERVICE-012`: the drain closes admission, winds every accepted session
    // down, and then waits on the server's own handler and worker counters up to
    // the configured grace. Only counts are logged if the grace expires.
    let grace = state.ws_timeouts.drain_grace;
    match begin_drain_and_wait(&state, grace).await {
        DrainOutcome::Drained => {
            tracing::info!("viva agent voice runtime drained");
        }
        DrainOutcome::TimedOut(snapshot) => {
            tracing::warn!(
                grace_seconds = grace.as_secs(),
                active_handlers = snapshot.active_handlers,
                background_workers = snapshot.background_workers,
                session_in_use = snapshot.session_in_use,
                session_capacity = snapshot.session_capacity,
                user_leases = snapshot.user_leases,
                ip_leases = snapshot.ip_leases,
                provider_inflight = snapshot.provider_inflight,
                provider_waiting = snapshot.provider_waiting,
                "viva agent drain grace expired"
            );
        }
    }
}
