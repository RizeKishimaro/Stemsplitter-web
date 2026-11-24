//! Opt-in persistence test. It never uses DATABASE_URL and requires an
//! explicitly configured disposable database; every write is rolled back.

#[tokio::test]
async fn project_insert_and_read_round_trip() {
    let Ok(database_url) = std::env::var("SONICLAB_TEST_DATABASE_URL") else {
        eprintln!("skipping project persistence: SONICLAB_TEST_DATABASE_URL is unset");
        return;
    };

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect only to the explicitly configured test database");
    let mut transaction = pool.begin().await.expect("begin rollback transaction");
    let project = sqlx::query_as::<_, (uuid::Uuid, String, Option<String>)>(
        "INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id, name, description",
    )
    .bind("Persistence test")
    .bind(Some("transaction is rolled back"))
    .fetch_one(&mut *transaction)
    .await
    .expect("insert test project");
    let fetched = sqlx::query_as::<_, (uuid::Uuid, String, Option<String>)>(
        "SELECT id, name, description FROM projects WHERE id = $1",
    )
    .bind(project.0)
    .fetch_one(&mut *transaction)
    .await
    .expect("read inserted test project");

    assert_eq!(fetched, project);
    transaction.rollback().await.expect("roll back test write");
    pool.close().await;
}
