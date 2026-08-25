//! SQLite persistence layer — `books` + `jobs`.
//!
//! Two tables back the personal server (ADR-0013): `books` mirrors each
//! bundle's `BookMeta` so the library can be browsed/listed without opening the
//! bundle file, and `jobs` tracks synth/resynth lifecycle. `books` rows are
//! written by the ingest path (T6/T8); `jobs` rows by the synth runner (T9).
//!
//! # Sync under tokio — `spawn_blocking`
//!
//! GOTCHA: rusqlite is synchronous. Every call from an async handler or the
//! synth runner MUST go through `tokio::task::spawn_blocking`, or the runtime
//! stalls on the (blocking) SQLite syscall. The `Db` trait methods themselves
//! are sync — they don't know about tokio — so the wrapping happens at the call
//! site. This matches the spec's rusqlite-under-tokio risk + ADR-0013
//! "SQLite-default". SQLite is never on the synth hot path (the rayon pool is).
//!
//! # Testability — the `Db` trait seam
//!
//! The [`Db`] trait fronts every query so HTTP handlers (T7+) are unit-testable
//! with an in-memory stub ([`test_utils::StubDb`]) — no real SQLite, no
//! network, no piper in handler tests.
//!
//! # Dead-code window (T5 → T9)
//!
//! The books half of this module's public API is wired into the axum app as of
//! T7 (`AppState.db` + the read handlers).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{types::FromSqlResult, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Errors surfaced by the SQLite layer.
///
/// Kept small: rusqlite + io are the only sources. Handler code maps these to
/// HTTP statuses in T7; nothing here knows about HTTP.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    /// A rusqlite call failed (constraint, bad SQL, conversion, …).
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// A filesystem error while opening the db file / parent dir.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// A row of the `books` table — a mirror of bundle `BookMeta`.
///
/// Written by the ingest path on upload/import (T6/T8). Integer columns use
/// `i64` (SQLite's native `INTEGER`); the ingest path casts `u32`/`u64` from
/// `BookMeta` at the boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookRow {
    /// Bundle `book.id` (TaleTrek `BookId`).
    pub id: String,
    /// Book title.
    pub title: String,
    /// Author, if known (`NULL` when absent).
    pub author: Option<String>,
    /// `pdf`/`epub`/`mobi`/`txt`/`md`/`unknown`.
    pub source_format: String,
    /// Voice id used for (or intended for) synthesis.
    pub voice_id: String,
    /// `true` when the bundle carries audio segments.
    pub audio_present: bool,
    /// Number of chapters.
    pub chapter_count: i64,
    /// Creation time, ms since epoch.
    pub created_at: i64,
    /// Last-update time, ms since epoch.
    pub updated_at: i64,
    /// The `updated_at` this book's chapters were exploded from (T9), or
    /// `None` when not (yet) exploded. A re-ingest or post-synth upsert
    /// constructs the row fresh (`None`) with a bumped `updated_at`, so the
    /// next `GET .../chapters` re-explodes — compare-on-request freshness with
    /// no coupling into the synth runner.
    pub exploded_at: Option<i64>,
}

/// One exploded chapter row (T9) — a `text.json` chapter flattened into
/// SQLite. `paragraphs` lives as a JSON array in its column (the SPA `Chapter`
/// shape); the wire `id` is derived (`ch_<bookId>_<idx>`) at serve time, so no
/// id column exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChapterRow {
    /// Zero-based chapter index.
    pub idx: i64,
    /// Chapter title.
    pub title: String,
    /// Cleaned paragraph strings.
    pub paragraphs: Vec<String>,
}

/// Synth vs. resynth. Stored as lowercase text in the `kind` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    /// First-time synthesis of a text-only bundle.
    Synth,
    /// Re-synthesizing an already-audio bundle under a new voice.
    Resynth,
}

/// Job lifecycle state. Stored as lowercase text in the `status` column.
///
/// Mirrors the SPA's variant-state pattern (`{ type: 'loading' }` etc.): the
/// string is the wire format both for the SQLite column and the JSON API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    /// Created, waiting for a worker to pick it up.
    Queued,
    /// A worker is synthesizing.
    Running,
    /// Completed; the bundle now carries audio.
    Succeeded,
    /// Terminal failure — see `JobRow.error`.
    Failed,
}

/// A row of the `jobs` table — one synth/resynth run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobRow {
    /// Job id (caller-generated uuid at create time).
    pub id: String,
    /// The book this job is synthesizing.
    pub book_id: String,
    /// `synth` or `resynth`.
    pub kind: JobKind,
    /// Voice id the job runs under.
    pub voice: String,
    /// Lifecycle state.
    pub status: JobStatus,
    /// Paragraphs completed so far.
    pub done: i64,
    /// Total paragraphs to synthesize.
    pub total: i64,
    /// Failure message, set when `status == Failed`.
    pub error: Option<String>,
    /// Creation time, ms since epoch.
    pub created_at: i64,
    /// Last-update time, ms since epoch.
    pub updated_at: i64,
}

/// The query surface used by HTTP handlers + the synth runner.
///
/// Every method is synchronous — rusqlite is sync. Callers in async contexts
/// wrap each call in `tokio::task::spawn_blocking` (see the module docs).
///
/// `Send + Sync` is required so a `Box<dyn Db>` (or `Arc<dyn Db>`) can be
/// shared across axum tasks. [`SqliteDb`] achieves it with a `Mutex<Connection>`;
/// [`test_utils::StubDb`] with a `Mutex<HashMap>`.
pub trait Db: Send + Sync {
    /// Insert or replace a book row (idempotent upsert keyed on `id`). The
    /// row's `exploded_at` is written verbatim — ingest/synth callers pass
    /// `None`, which is exactly the "re-explode on next read" reset.
    fn upsert_book(&self, row: BookRow) -> Result<(), DbError>;
    /// Fetch one book by id, or `None` if absent.
    fn get_book(&self, id: &str) -> Result<Option<BookRow>, DbError>;
    /// List all books, newest-first by `created_at`.
    fn list_books(&self) -> Result<Vec<BookRow>, DbError>;
    /// Delete one book by id **including its exploded chapter rows** (T9
    /// cascade — chapters must not outlive their book). Returns `true` if a
    /// row was removed.
    fn delete_book(&self, id: &str) -> Result<bool, DbError>;

    /// Atomically replace a book's exploded chapter rows and stamp
    /// `exploded_at = marker` on the book (T9). Idempotent upsert — rows are
    /// deterministic from the same bundle, so concurrent first-hits are
    /// last-writer-wins with no visible double-explode.
    fn replace_chapters(
        &self,
        book_id: &str,
        rows: Vec<ChapterRow>,
        marker: i64,
    ) -> Result<(), DbError>;
    /// A book's chapter rows ordered by `idx` (empty when none). Serviced from
    /// SQLite — no bundle read involved.
    fn list_chapters(&self, book_id: &str) -> Result<Vec<ChapterRow>, DbError>;

    /// Insert a fresh job row (caller supplies the id + initial fields).
    /// Returns the inserted job's id.
    fn create_job(&self, row: JobRow) -> Result<String, DbError>;
    /// Transition a job's status, optionally bumping progress / setting an
    /// error. `None` for `done`/`total`/`error` means "leave the column
    /// unchanged". Returns `true` if the row existed.
    fn update_job_status(
        &self,
        id: &str,
        status: JobStatus,
        done: Option<i64>,
        total: Option<i64>,
        error: Option<&str>,
    ) -> Result<bool, DbError>;
    /// Fetch one job by id, or `None` if absent.
    fn get_job(&self, id: &str) -> Result<Option<JobRow>, DbError>;
    /// List the `limit` most-recently-updated jobs.
    fn list_recent_jobs(&self, limit: usize) -> Result<Vec<JobRow>, DbError>;
    /// Mark every `queued`/`running` job as `failed` with `error`. The boot
    /// sweep: jobs orphaned by a crash/restart are owned by no process and
    /// would otherwise lie `running` forever. Returns the swept count.
    fn fail_active_jobs(&self, error: &str) -> Result<u64, DbError>;
}

/// SQLite-backed [`Db`]. Owns a single [`Connection`] guarded by a `Mutex`.
///
/// WAL journal mode + `busy_timeout` are set on open so a future read pool
/// (multiple connections) gets concurrent reads during a synth write "for free".
/// v1 uses a single connection serialized through the mutex; the PRAGMAs are
/// forward-looking and persist in the db file.
pub struct SqliteDb {
    conn: Mutex<Connection>,
}

impl SqliteDb {
    /// Open (or create) the db at `path`, run idempotent migrations, set
    /// `journal_mode=WAL` + `busy_timeout`.
    ///
    /// The parent dir must already exist — boot creates `data_dir` before
    /// calling this. Re-opening an existing db is safe (migrations use
    /// `IF NOT EXISTS`).
    pub fn open(path: &Path) -> Result<Self, DbError> {
        let conn = Connection::open(path)?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Run `CREATE TABLE IF NOT EXISTS` + indexes + PRAGMAs. Idempotent.
    ///
    /// WAL + `busy_timeout` are forward-looking: v1 uses a single connection
    /// (serialized through the mutex), but these PRAGMAs persist in the db file
    /// so a future read pool gets concurrent-reads-during-write "for free".
    ///
    /// T9 adds the `chapters` table + `books.exploded_at`. Fresh dbs get both
    /// in the CREATE batch; pre-T9 db files are upgraded with a guarded
    /// `ALTER TABLE` (checked via `pragma_table_info` so re-opens stay no-ops).
    fn migrate(conn: &Connection) -> Result<(), DbError> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 5_000i64)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS books(
                id             TEXT PRIMARY KEY,
                title          TEXT NOT NULL,
                author         TEXT,
                source_format  TEXT NOT NULL,
                voice_id       TEXT NOT NULL,
                audio_present  INTEGER NOT NULL,
                chapter_count  INTEGER NOT NULL,
                created_at     INTEGER NOT NULL,
                updated_at     INTEGER NOT NULL,
                exploded_at    INTEGER
            );
            CREATE TABLE IF NOT EXISTS chapters(
                book_id     TEXT NOT NULL,
                idx         INTEGER NOT NULL,
                title       TEXT NOT NULL,
                paragraphs  TEXT NOT NULL,
                PRIMARY KEY (book_id, idx)
            );
            CREATE TABLE IF NOT EXISTS jobs(
                id          TEXT PRIMARY KEY,
                book_id     TEXT NOT NULL,
                kind        TEXT NOT NULL,
                voice       TEXT NOT NULL,
                status      TEXT NOT NULL,
                done        INTEGER NOT NULL,
                total       INTEGER NOT NULL,
                error       TEXT,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_book_id ON jobs(book_id);
            CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
            CREATE INDEX IF NOT EXISTS idx_books_title  ON books(title);",
        )?;
        // Effort-4-era db files predate `books.exploded_at` — add it in place.
        let has_exploded_at: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('books') WHERE name = 'exploded_at'",
            [],
            |r| r.get(0),
        )?;
        if has_exploded_at == 0 {
            conn.execute("ALTER TABLE books ADD COLUMN exploded_at INTEGER", [])?;
        }
        Ok(())
    }
}

impl Db for SqliteDb {
    fn upsert_book(&self, row: BookRow) -> Result<(), DbError> {
        let conn = self.conn.lock().unwrap();
        upsert_book_row(&conn, &row)
    }

    fn get_book(&self, id: &str) -> Result<Option<BookRow>, DbError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,title,author,source_format,voice_id,audio_present,chapter_count,created_at,updated_at,exploded_at FROM books WHERE id = ?1",
        )?;
        let row = stmt.query_row([id], book_from_row).optional()?;
        Ok(row)
    }

    fn list_books(&self) -> Result<Vec<BookRow>, DbError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            // `id` tiebreaks same-ms created_at stamps (bulk library imports)
            // so the newest-first order is stable across requests.
            "SELECT id,title,author,source_format,voice_id,audio_present,chapter_count,created_at,updated_at,exploded_at FROM books ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([], book_from_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    fn delete_book(&self, id: &str) -> Result<bool, DbError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM chapters WHERE book_id = ?1", [id])?;
        let n = tx.execute("DELETE FROM books WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(n == 1)
    }

    fn replace_chapters(
        &self,
        book_id: &str,
        rows: Vec<ChapterRow>,
        marker: i64,
    ) -> Result<(), DbError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM chapters WHERE book_id = ?1", [book_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO chapters(book_id,idx,title,paragraphs) VALUES (?1,?2,?3,?4)",
            )?;
            for row in &rows {
                let paragraphs = serde_json::to_string(&row.paragraphs)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                stmt.execute(rusqlite::params![book_id, row.idx, row.title, paragraphs])?;
            }
        }
        tx.execute(
            "UPDATE books SET exploded_at = ?2 WHERE id = ?1",
            rusqlite::params![book_id, marker],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn list_chapters(&self, book_id: &str) -> Result<Vec<ChapterRow>, DbError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT idx,title,paragraphs FROM chapters WHERE book_id = ?1 ORDER BY idx ASC",
        )?;
        let rows = stmt.query_map([book_id], chapter_from_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    fn create_job(&self, row: JobRow) -> Result<String, DbError> {
        let conn = self.conn.lock().unwrap();
        let id = row.id.clone();
        conn.execute(
            "INSERT INTO jobs(id,book_id,kind,voice,status,done,total,error,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            rusqlite::params![
                row.id,
                row.book_id,
                row.kind,
                row.voice,
                row.status,
                row.done,
                row.total,
                row.error,
                row.created_at,
                row.updated_at,
            ],
        )?;
        Ok(id)
    }

    fn update_job_status(
        &self,
        id: &str,
        status: JobStatus,
        done: Option<i64>,
        total: Option<i64>,
        error: Option<&str>,
    ) -> Result<bool, DbError> {
        let conn = self.conn.lock().unwrap();
        apply_status_update(&conn, id, status, done, total, error)
    }

    fn get_job(&self, id: &str) -> Result<Option<JobRow>, DbError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id,book_id,kind,voice,status,done,total,error,created_at,updated_at FROM jobs WHERE id = ?1")?;
        let row = stmt.query_row([id], job_from_row).optional()?;
        Ok(row)
    }

    fn list_recent_jobs(&self, limit: usize) -> Result<Vec<JobRow>, DbError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id,book_id,kind,voice,status,done,total,error,created_at,updated_at FROM jobs ORDER BY updated_at DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit as i64], job_from_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    fn fail_active_jobs(&self, error: &str) -> Result<u64, DbError> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE jobs SET status = 'failed', error = ?1, updated_at = ?2
             WHERE status IN ('queued', 'running')",
            rusqlite::params![error, now_ms()],
        )?;
        Ok(n as u64)
    }
}

// ----- helpers -----

/// Insert-or-replace a [`BookRow`] (keyed on `id`).
fn upsert_book_row(conn: &Connection, row: &BookRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR REPLACE INTO books(id,title,author,source_format,voice_id,audio_present,chapter_count,created_at,updated_at,exploded_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        rusqlite::params![
            row.id,
            row.title,
            row.author,
            row.source_format,
            row.voice_id,
            row.audio_present,
            row.chapter_count,
            row.created_at,
            row.updated_at,
            row.exploded_at,
        ],
    )?;
    Ok(())
}

/// Map a SELECT row into a [`BookRow`]. Column order matches the SELECT lists.
fn book_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookRow> {
    Ok(BookRow {
        id: row.get(0)?,
        title: row.get(1)?,
        author: row.get(2)?,
        source_format: row.get(3)?,
        voice_id: row.get(4)?,
        audio_present: row.get(5)?,
        chapter_count: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        exploded_at: row.get(9)?,
    })
}

/// Map a SELECT row into a [`ChapterRow`]. Column order matches the SELECT
/// list; `paragraphs` is the JSON array stored by [`Db::replace_chapters`].
fn chapter_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChapterRow> {
    let paragraphs_json: String = row.get(2)?;
    let paragraphs = serde_json::from_str(&paragraphs_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(ChapterRow {
        idx: row.get(0)?,
        title: row.get(1)?,
        paragraphs,
    })
}

/// Map a SELECT row into a [`JobRow`]. Column order matches the SELECT lists.
fn job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JobRow> {
    Ok(JobRow {
        id: row.get(0)?,
        book_id: row.get(1)?,
        kind: row.get(2)?,
        voice: row.get(3)?,
        status: row.get(4)?,
        done: row.get(5)?,
        total: row.get(6)?,
        error: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}
/// Build + run a dynamic UPDATE for `update_job_status`. Only the supplied
/// (`Some`) columns are written; the rest keep their current values.
fn apply_status_update(
    conn: &Connection,
    id: &str,
    status: JobStatus,
    done: Option<i64>,
    total: Option<i64>,
    error: Option<&str>,
) -> Result<bool, DbError> {
    // Build `SET status=?, updated_at=?, [<col>=?, …] WHERE id=?` with plain `?`
    // placeholders, auto-numbered by rusqlite to match the param slice order.
    let mut sql = String::from("UPDATE jobs SET status = ?, updated_at = ?");
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(status), Box::new(now_ms())];
    if let Some(d) = done {
        sql.push_str(", done = ?");
        params.push(Box::new(d));
    }
    if let Some(t) = total {
        sql.push_str(", total = ?");
        params.push(Box::new(t));
    }
    if let Some(e) = error {
        sql.push_str(", error = ?");
        params.push(Box::new(e.to_string()));
    }
    sql.push_str(" WHERE id = ?");
    params.push(Box::new(id.to_string()));

    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let n = conn.execute(&sql, refs.as_slice())?;
    Ok(n == 1)
}
/// Wall-clock ms since the unix epoch (i64; clamped to 0 if the clock is
/// before `UNIX_EPOCH`, which never happens in practice).
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ===== ToSql / FromSql for the enums (lowercase text) =====

impl rusqlite::types::ToSql for JobKind {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        self.as_str().to_sql()
    }
}
impl rusqlite::types::FromSql for JobKind {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "synth" => Ok(Self::Synth),
            "resynth" => Ok(Self::Resynth),
            _ => Err(rusqlite::types::FromSqlError::InvalidType),
        }
    }
}
impl rusqlite::types::ToSql for JobStatus {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        self.as_str().to_sql()
    }
}
impl rusqlite::types::FromSql for JobStatus {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            _ => Err(rusqlite::types::FromSqlError::InvalidType),
        }
    }
}

impl JobKind {
    /// Lowercase wire string (`"synth"` / `"resynth"`).
    fn as_str(&self) -> &'static str {
        match self {
            Self::Synth => "synth",
            Self::Resynth => "resynth",
        }
    }
}
impl JobStatus {
    /// Lowercase wire string (`"queued"` / `"running"` / `"succeeded"` / `"failed"`).
    fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

/// In-memory test doubles — visible to other modules' tests within this crate
/// (e.g. the HTTP handler tests in T7).
#[cfg(test)]
pub mod test_utils {
    use super::*;

    /// A `Vec`/`HashMap`-backed [`Db`] stub. No SQLite — for handler unit tests.
    pub struct StubDb {
        books: Mutex<std::collections::HashMap<String, BookRow>>,
        jobs: Mutex<std::collections::HashMap<String, JobRow>>,
        chapters: Mutex<std::collections::HashMap<String, Vec<ChapterRow>>>,
    }

    impl StubDb {
        /// Empty stub.
        pub fn new() -> Self {
            Self {
                books: Mutex::new(std::collections::HashMap::new()),
                jobs: Mutex::new(std::collections::HashMap::new()),
                chapters: Mutex::new(std::collections::HashMap::new()),
            }
        }
    }

    impl Default for StubDb {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Db for StubDb {
        fn upsert_book(&self, row: BookRow) -> Result<(), DbError> {
            self.books.lock().unwrap().insert(row.id.clone(), row);
            Ok(())
        }
        fn get_book(&self, id: &str) -> Result<Option<BookRow>, DbError> {
            Ok(self.books.lock().unwrap().get(id).cloned())
        }
        fn list_books(&self) -> Result<Vec<BookRow>, DbError> {
            let mut v: Vec<BookRow> = self.books.lock().unwrap().values().cloned().collect();
            v.sort_by_key(|b| std::cmp::Reverse(b.created_at));
            Ok(v)
        }
        fn delete_book(&self, id: &str) -> Result<bool, DbError> {
            let removed = self.books.lock().unwrap().remove(id).is_some();
            self.chapters.lock().unwrap().remove(id);
            Ok(removed)
        }
        fn replace_chapters(
            &self,
            book_id: &str,
            mut rows: Vec<ChapterRow>,
            marker: i64,
        ) -> Result<(), DbError> {
            rows.sort_by_key(|r| r.idx);
            self.chapters
                .lock()
                .unwrap()
                .insert(book_id.to_string(), rows);
            if let Some(b) = self.books.lock().unwrap().get_mut(book_id) {
                b.exploded_at = Some(marker);
            }
            Ok(())
        }
        fn list_chapters(&self, book_id: &str) -> Result<Vec<ChapterRow>, DbError> {
            Ok(self
                .chapters
                .lock()
                .unwrap()
                .get(book_id)
                .cloned()
                .unwrap_or_default())
        }
        fn create_job(&self, row: JobRow) -> Result<String, DbError> {
            let id = row.id.clone();
            self.jobs.lock().unwrap().insert(id.clone(), row);
            Ok(id)
        }
        fn update_job_status(
            &self,
            id: &str,
            status: JobStatus,
            done: Option<i64>,
            total: Option<i64>,
            error: Option<&str>,
        ) -> Result<bool, DbError> {
            let mut jobs = self.jobs.lock().unwrap();
            if let Some(j) = jobs.get_mut(id) {
                j.status = status;
                if let Some(d) = done {
                    j.done = d;
                }
                if let Some(t) = total {
                    j.total = t;
                }
                if let Some(e) = error {
                    j.error = Some(e.to_string());
                }
                j.updated_at = now_ms();
                Ok(true)
            } else {
                Ok(false)
            }
        }
        fn get_job(&self, id: &str) -> Result<Option<JobRow>, DbError> {
            Ok(self.jobs.lock().unwrap().get(id).cloned())
        }
        fn list_recent_jobs(&self, limit: usize) -> Result<Vec<JobRow>, DbError> {
            let mut v: Vec<JobRow> = self.jobs.lock().unwrap().values().cloned().collect();
            v.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
            v.truncate(limit);
            Ok(v)
        }
        fn fail_active_jobs(&self, error: &str) -> Result<u64, DbError> {
            let mut jobs = self.jobs.lock().unwrap();
            let now = now_ms();
            let mut swept = 0;
            for j in jobs.values_mut() {
                if matches!(j.status, JobStatus::Queued | JobStatus::Running) {
                    j.status = JobStatus::Failed;
                    j.error = Some(error.to_string());
                    j.updated_at = now;
                    swept += 1;
                }
            }
            Ok(swept)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_utils::StubDb;

    // ---- fixtures ----

    fn sample_book(id: &str) -> BookRow {
        BookRow {
            id: id.to_string(),
            title: format!("Title {id}"),
            author: Some(format!("Author {id}")),
            source_format: "epub".to_string(),
            voice_id: "en_US-lessac".to_string(),
            audio_present: false,
            chapter_count: 12,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            exploded_at: None,
        }
    }

    fn sample_job(id: &str, book_id: &str) -> JobRow {
        JobRow {
            id: id.to_string(),
            book_id: book_id.to_string(),
            kind: JobKind::Synth,
            voice: "en_US-lessac".to_string(),
            status: JobStatus::Queued,
            done: 0,
            total: 100,
            error: None,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
        }
    }

    // ---- SqliteDb: migrations ----

    #[test]
    fn sqlite_migrations_create_tables_and_are_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("taletrek.db");
        let db = SqliteDb::open(&db_path).expect("open fresh");
        // Round-trip proves both tables exist.
        db.upsert_book(sample_book("b1")).unwrap();
        let got = db.get_book("b1").unwrap();
        assert!(got.is_some(), "books table works after migrate");
        drop(db);
        // Re-open the same file: migrations must not double-create.
        let db2 = SqliteDb::open(&db_path).expect("reopen existing");
        assert_eq!(db2.list_books().unwrap().len(), 1, "data persisted");
    }

    // ---- SqliteDb: books round-trip ----

    #[test]
    fn sqlite_book_upsert_get_list_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let db = SqliteDb::open(&tmp.path().join("taletrek.db")).unwrap();

        // empty
        assert!(db.list_books().unwrap().is_empty());
        assert_eq!(db.get_book("missing").unwrap(), None);

        // insert + get, every field round-trips
        let mut row = sample_book("b1");
        row.author = None;
        row.audio_present = true;
        db.upsert_book(row.clone()).unwrap();
        let got = db.get_book("b1").unwrap().unwrap();
        assert_eq!(got, row);
        assert_eq!(got.author, None);
        assert!(got.audio_present);

        // second book, list returns all
        db.upsert_book(sample_book("b2")).unwrap();
        let all = db.list_books().unwrap();
        assert_eq!(all.len(), 2);

        // re-upsert same id updates (idempotent upsert)
        let mut updated = sample_book("b1");
        updated.title = "New Title".into();
        updated.updated_at = row.updated_at + 1000;
        db.upsert_book(updated.clone()).unwrap();
        assert_eq!(db.list_books().unwrap().len(), 2, "no new row");
        assert_eq!(
            db.get_book("b1").unwrap().unwrap().title,
            "New Title",
            "row updated in place"
        );

        // delete
        assert!(db.delete_book("b1").unwrap());
        assert_eq!(db.get_book("b1").unwrap(), None, "deleted is gone");
        assert!(!db.delete_book("b1").unwrap(), "second delete is false");
        assert_eq!(db.list_books().unwrap().len(), 1);
    }

    // ---- SqliteDb: jobs lifecycle ----

    #[test]
    fn sqlite_job_create_update_transition_get_list() {
        let tmp = tempfile::tempdir().unwrap();
        let db = SqliteDb::open(&tmp.path().join("taletrek.db")).unwrap();

        // create
        let id = db.create_job(sample_job("j1", "b1")).unwrap();
        assert_eq!(id, "j1");

        // queued → running, set total
        assert!(db
            .update_job_status("j1", JobStatus::Running, None, Some(120), None)
            .unwrap());
        let running = db.get_job("j1").unwrap().unwrap();
        assert_eq!(running.status, JobStatus::Running);
        assert_eq!(running.total, 120);
        assert_eq!(running.done, 0, "done untouched");

        // running → succeeded, set done = total
        assert!(db
            .update_job_status("j1", JobStatus::Succeeded, Some(120), None, None)
            .unwrap());
        let ok = db.get_job("j1").unwrap().unwrap();
        assert_eq!(ok.status, JobStatus::Succeeded);
        assert_eq!(ok.done, 120);

        // separate failed path with error + paragraph index
        db.create_job(sample_job("j2", "b1")).unwrap();
        assert!(db
            .update_job_status("j2", JobStatus::Failed, Some(47), None, Some("boom"))
            .unwrap());
        let fail = db.get_job("j2").unwrap().unwrap();
        assert_eq!(fail.status, JobStatus::Failed);
        assert_eq!(fail.done, 47);
        assert_eq!(fail.error.as_deref(), Some("boom"));

        // update of missing job returns false
        assert!(!db
            .update_job_status("nope", JobStatus::Running, None, None, None)
            .unwrap());

        // list_recent_jobs returns both, newest-updated first
        let recent = db.list_recent_jobs(10).unwrap();
        assert_eq!(recent.len(), 2);
        assert!(recent[0].updated_at >= recent[1].updated_at);
    }

    // ---- boot sweep ----

    #[test]
    fn fail_active_jobs_sweeps_only_unfinished_jobs() {
        let tmp = tempfile::tempdir().unwrap();
        let db = SqliteDb::open(&tmp.path().join("taletrek.db")).unwrap();

        db.create_job(sample_job("j-queued", "b1")).unwrap();
        let mut running = sample_job("j-running", "b1");
        running.status = JobStatus::Running;
        db.create_job(running).unwrap();
        let mut done = sample_job("j-done", "b1");
        done.status = JobStatus::Succeeded;
        db.create_job(done).unwrap();

        let swept = db.fail_active_jobs("server restarted during job").unwrap();
        assert_eq!(swept, 2);
        for id in ["j-queued", "j-running"] {
            let j = db.get_job(id).unwrap().unwrap();
            assert_eq!(j.status, JobStatus::Failed, "{id} must be swept");
            assert_eq!(j.error.as_deref(), Some("server restarted during job"));
        }
        let untouched = db.get_job("j-done").unwrap().unwrap();
        assert_eq!(untouched.status, JobStatus::Succeeded);
        assert_eq!(untouched.error, None);

        // Second sweep is a no-op.
        assert_eq!(db.fail_active_jobs("again").unwrap(), 0);
    }

    #[test]
    fn stub_fail_active_jobs_matches_sqlite_behavior() {
        let db = StubDb::new();
        db.create_job(sample_job("s1", "b1")).unwrap();
        let mut running = sample_job("s2", "b1");
        running.status = JobStatus::Running;
        db.create_job(running).unwrap();

        assert_eq!(db.fail_active_jobs("sweep").unwrap(), 2);
        assert_eq!(db.get_job("s1").unwrap().unwrap().status, JobStatus::Failed);
        assert_eq!(
            db.get_job("s2").unwrap().unwrap().error.as_deref(),
            Some("sweep")
        );
        assert_eq!(db.fail_active_jobs("sweep").unwrap(), 0);
    }

    // ---- serde wire format ----

    #[test]
    fn job_status_and_kind_serialize_lowercase() {
        assert_eq!(
            serde_json::to_string(&JobStatus::Queued).unwrap(),
            "\"queued\""
        );
        assert_eq!(
            serde_json::to_string(&JobStatus::Succeeded).unwrap(),
            "\"succeeded\""
        );
        assert_eq!(serde_json::to_string(&JobKind::Synth).unwrap(), "\"synth\"");
        assert_eq!(
            serde_json::to_string(&JobKind::Resynth).unwrap(),
            "\"resynth\""
        );
    }

    // ---- StubDb smoke (trait parity) ----

    #[test]
    fn stub_db_satisfies_trait_and_round_trips_one_query() {
        let db = StubDb::new();
        let row = sample_book("sb1");
        db.upsert_book(row.clone()).unwrap();
        assert_eq!(db.get_book("sb1").unwrap(), Some(row));
        assert_eq!(db.list_books().unwrap().len(), 1);
        assert!(db.delete_book("sb1").unwrap());
    }

    // ===== T9: chapters table + exploded_at marker =====

    fn chapter_row(idx: i64, title: &str, paragraphs: &[&str]) -> ChapterRow {
        ChapterRow {
            idx,
            title: title.to_string(),
            paragraphs: paragraphs.iter().map(|p| p.to_string()).collect(),
        }
    }

    /// A pre-T9 db file (books table without `exploded_at`, no `chapters`
    /// table) migrates in place on open — the effort-4-library upgrade path.
    #[test]
    fn sqlite_migration_adds_chapters_surface_to_existing_db() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("taletrek.db");
        {
            let legacy = Connection::open(&db_path).unwrap();
            legacy
                .execute_batch(
                    "CREATE TABLE books(
                        id             TEXT PRIMARY KEY,
                        title          TEXT NOT NULL,
                        author         TEXT,
                        source_format  TEXT NOT NULL,
                        voice_id       TEXT NOT NULL,
                        audio_present  INTEGER NOT NULL,
                        chapter_count  INTEGER NOT NULL,
                        created_at     INTEGER NOT NULL,
                        updated_at     INTEGER NOT NULL
                    );",
                )
                .unwrap();
            legacy
                .execute(
                    "INSERT INTO books VALUES('b1','T',NULL,'txt','v',0,1,1,1)",
                    [],
                )
                .unwrap();
        }
        // Open through SqliteDb — migration must add the column + table.
        let db = SqliteDb::open(&db_path).expect("migrates legacy db");
        let book = db.get_book("b1").unwrap().expect("row survived");
        assert_eq!(book.exploded_at, None, "legacy row starts un-exploded");
        // The chapters surface round-trips on the migrated file.
        db.replace_chapters("b1", vec![chapter_row(0, "One", &["a."])], book.updated_at)
            .unwrap();
        assert_eq!(
            db.get_book("b1").unwrap().unwrap().exploded_at,
            Some(book.updated_at),
            "marker set"
        );
        assert_eq!(db.list_chapters("b1").unwrap().len(), 1);
    }

    #[test]
    fn sqlite_replace_and_list_chapters_round_trip_ordered() {
        let tmp = tempfile::tempdir().unwrap();
        let db = SqliteDb::open(&tmp.path().join("taletrek.db")).unwrap();
        db.upsert_book(sample_book("b1")).unwrap();

        // Insert out of order — list must come back by idx.
        let rows = vec![
            chapter_row(2, "Two", &["x.", "y."]),
            chapter_row(0, "Zero", &[]),
            chapter_row(1, "One", &["hello"]),
        ];
        db.replace_chapters("b1", rows, 42).unwrap();

        let listed = db.list_chapters("b1").unwrap();
        assert_eq!(
            listed,
            vec![
                chapter_row(0, "Zero", &[]),
                chapter_row(1, "One", &["hello"]),
                chapter_row(2, "Two", &["x.", "y."]),
            ],
            "idx order + paragraphs round-trip"
        );
        assert_eq!(
            db.get_book("b1").unwrap().unwrap().exploded_at,
            Some(42),
            "marker stamped"
        );

        // Absent book lists empty (no error).
        assert!(db.list_chapters("missing").unwrap().is_empty());
    }

    #[test]
    fn sqlite_replace_chapters_is_a_replace_not_append() {
        let tmp = tempfile::tempdir().unwrap();
        let db = SqliteDb::open(&tmp.path().join("taletrek.db")).unwrap();
        db.upsert_book(sample_book("b1")).unwrap();

        db.replace_chapters(
            "b1",
            vec![
                chapter_row(0, "Old 0", &["a"]),
                chapter_row(1, "Old 1", &["b"]),
            ],
            1,
        )
        .unwrap();
        // Re-explode with a single chapter — the old rows must be gone.
        db.replace_chapters("b1", vec![chapter_row(0, "New 0", &["c"])], 2)
            .unwrap();
        let listed = db.list_chapters("b1").unwrap();
        assert_eq!(listed.len(), 1, "no stale rows survive a re-explode");
        assert_eq!(listed[0].title, "New 0");
    }

    #[test]
    fn sqlite_upsert_book_resets_exploded_at_and_delete_cascades_chapters() {
        let tmp = tempfile::tempdir().unwrap();
        let db = SqliteDb::open(&tmp.path().join("taletrek.db")).unwrap();
        db.upsert_book(sample_book("b1")).unwrap();
        db.replace_chapters(
            "b1",
            vec![chapter_row(0, "One", &["a."])],
            1_700_000_000_000,
        )
        .unwrap();
        assert!(db.get_book("b1").unwrap().unwrap().exploded_at.is_some());

        // A re-ingest / post-synth upsert constructs the row fresh (marker
        // None) → the next chapters fetch must re-explode.
        let mut re = sample_book("b1");
        re.updated_at = 1_700_000_000_999;
        db.upsert_book(re).unwrap();
        assert_eq!(
            db.get_book("b1").unwrap().unwrap().exploded_at,
            None,
            "upsert resets the marker"
        );
        assert_eq!(
            db.list_chapters("b1").unwrap().len(),
            1,
            "chapter rows survive the upsert (re-explode cleans them)"
        );

        // Delete cascades to chapters.
        assert!(db.delete_book("b1").unwrap());
        assert!(db.list_chapters("b1").unwrap().is_empty());
    }

    #[test]
    fn stub_replace_and_list_chapters_matches_sqlite_behavior() {
        let db = StubDb::new();
        db.upsert_book(sample_book("b1")).unwrap();
        let rows = vec![
            chapter_row(1, "One", &["a."]),
            chapter_row(0, "Zero", &["z."]),
        ];
        db.replace_chapters("b1", rows, 7).unwrap();
        assert_eq!(
            db.list_chapters("b1").unwrap(),
            vec![
                chapter_row(0, "Zero", &["z."]),
                chapter_row(1, "One", &["a."]),
            ]
        );
        assert_eq!(db.get_book("b1").unwrap().unwrap().exploded_at, Some(7));
        db.delete_book("b1").unwrap();
        assert!(db.list_chapters("b1").unwrap().is_empty());
    }
}
