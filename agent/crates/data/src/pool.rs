use sqlx::{postgres::PgPoolOptions, PgPool};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PgConfig {
    pub database_url: String,
    pub max_connections: u32,
}

impl PgConfig {
    pub fn new(database_url: impl Into<String>) -> Self {
        Self {
            database_url: database_url.into(),
            max_connections: 5,
        }
    }
}

pub async fn connect_pg(config: &PgConfig) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(config.max_connections)
        .connect(&config.database_url)
        .await
}
