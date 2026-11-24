CREATE TABLE IF NOT EXISTS jobs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source              TEXT NOT NULL,
    external_id         TEXT NOT NULL,
    url                 TEXT NOT NULL,
    title               TEXT NOT NULL,
    company             TEXT NOT NULL,
    location            TEXT DEFAULT 'Singapore',
    salary_min          INTEGER,
    salary_max          INTEGER,
    salary_currency     TEXT DEFAULT 'SGD',
    salary_interval     TEXT,
    employment_type     TEXT,
    description_snippet TEXT,
    skills_json         TEXT,
    posted_at           TEXT,
    first_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
    status              TEXT NOT NULL DEFAULT 'new',
    notes               TEXT,
    company_research_json TEXT,
    UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS scrape_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL,
    query           TEXT NOT NULL,
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at     TEXT,
    status          TEXT NOT NULL,
    jobs_found      INTEGER NOT NULL DEFAULT 0,
    jobs_new        INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_last_seen ON jobs(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
