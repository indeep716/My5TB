-- Publication is an independent administrative preference, outside sync snapshots.
-- No foreign key: preserve the preference if ingestion replaces a content row.
CREATE TABLE IF NOT EXISTS publication_overrides(content_id TEXT PRIMARY KEY,published INTEGER NOT NULL CHECK(published IN (0,1)),updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
