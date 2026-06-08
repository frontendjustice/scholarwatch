-- ScholarWatch Supabase Schema
-- Run this in the Supabase SQL Editor after creating your project.
-- Tables: feeds, results, scan_log, bookmarks

-- 1. Feeds table
CREATE TABLE IF NOT EXISTS feeds (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL UNIQUE,
    active      BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Results table (the main scholarship data)
CREATE TABLE IF NOT EXISTS results (
    id              SERIAL PRIMARY KEY,
    title           TEXT NOT NULL,
    link            TEXT NOT NULL,
    description     TEXT,
    summary         TEXT,
    score           INTEGER DEFAULT 0,
    deadline        TEXT,
    source_feed     TEXT,
    criteria_json   JSONB DEFAULT '{}',
    scraped_content TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(link, title)
);

CREATE INDEX IF NOT EXISTS idx_results_score ON results(score);
CREATE INDEX IF NOT EXISTS idx_results_deadline ON results(deadline);
CREATE INDEX IF NOT EXISTS idx_results_created ON results(created_at DESC);

-- 3. Scan log
CREATE TABLE IF NOT EXISTS scan_log (
    id               SERIAL PRIMARY KEY,
    started_at       TIMESTAMPTZ DEFAULT NOW(),
    finished_at      TIMESTAMPTZ,
    feeds_checked    INTEGER DEFAULT 0,
    entries_found    INTEGER DEFAULT 0,
    entries_accepted INTEGER DEFAULT 0,
    status           TEXT DEFAULT 'running'
);

-- 4. Bookmarks
CREATE TABLE IF NOT EXISTS bookmarks (
    id          SERIAL PRIMARY KEY,
    result_id   INTEGER NOT NULL UNIQUE REFERENCES results(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ===== Row-Level Security (RLS) =====
-- Enable RLS on all tables
ALTER TABLE feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE results ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;

-- Public read access for anon key
CREATE POLICY "anon_read_feeds"    ON feeds     FOR SELECT USING (true);
CREATE POLICY "anon_read_results"  ON results   FOR SELECT USING (true);
CREATE POLICY "anon_read_scanlog"  ON scan_log  FOR SELECT USING (true);
CREATE POLICY "anon_read_bookmarks" ON bookmarks FOR SELECT USING (true);

-- Anonymous bookmark toggle (insert/delete own bookmarks)
CREATE POLICY "anon_insert_bookmarks" ON bookmarks FOR INSERT WITH CHECK (true);
CREATE POLICY "anon_delete_bookmarks" ON bookmarks FOR DELETE USING (true);

-- Anonymous delete individual results (the 'Delete' button in UI)
CREATE POLICY "anon_delete_results" ON results FOR DELETE USING (true);

-- Feeds management — restrict writes to authenticated users (supabase dashboard)
-- No anon insert/update/delete policies on feeds — managed via SQL editor
