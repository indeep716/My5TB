-- Quarantined public uploads never reference catalog/content tables.
CREATE TABLE submissions (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, source TEXT NOT NULL, artist TEXT NOT NULL,
 media_title TEXT NOT NULL, character_name TEXT NOT NULL, archive_name TEXT NOT NULL,
 archive_size INTEGER NOT NULL, image_count INTEGER NOT NULL DEFAULT 0, reserved_bytes INTEGER NOT NULL,
 upload_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','READY','REJECTED')),
 report TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, lock_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX submissions_expiry ON submissions(expires_at);
CREATE TABLE submission_parts (submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE, part_number INTEGER NOT NULL, etag TEXT NOT NULL, PRIMARY KEY(submission_id,part_number));
CREATE TABLE submission_images (submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE, image_number INTEGER NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(submission_id,image_number));
-- Reservations survive cancellation/deletion to prevent rate and daily budget bypass.
CREATE TABLE submission_usage (id TEXT PRIMARY KEY, ip_hash TEXT NOT NULL, reserved_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX submission_usage_ip ON submission_usage(ip_hash,created_at);
