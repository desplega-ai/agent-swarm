CREATE TABLE script_embeddings (
  scriptId TEXT PRIMARY KEY REFERENCES scripts(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  embeddingModel TEXT NOT NULL,
  embeddedText TEXT NOT NULL,
  embeddedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
