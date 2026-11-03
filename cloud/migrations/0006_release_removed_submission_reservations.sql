UPDATE submission_usage SET reserved_bytes=0 WHERE NOT EXISTS (SELECT 1 FROM submissions WHERE submissions.id=submission_usage.id);
