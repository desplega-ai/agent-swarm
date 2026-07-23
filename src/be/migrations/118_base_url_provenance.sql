ALTER TABLE script_connections
  ADD COLUMN base_url_source TEXT NOT NULL DEFAULT 'user'
  CHECK(base_url_source IN ('user', 'spec'));
