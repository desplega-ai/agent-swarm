-- Full-text index for ranked skill search (searchSkills / skill-search tool).
-- Same shape as memory_fts: an id column FTS5 does not index, the searchable
-- text columns, and the porter tokenizer. Column order matters: searchSkills
-- passes bm25() weights positionally (skill_id, name, description, content).
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  skill_id UNINDEXED,
  name,
  description,
  content,
  tokenize='porter unicode61'
);

INSERT INTO skills_fts(skill_id, name, description, content)
  SELECT id, name, description, content FROM skills
  WHERE id NOT IN (SELECT skill_id FROM skills_fts WHERE skill_id IS NOT NULL);

-- Triggers keep the index in sync on every write path, including FK cascade
-- deletes. A later migration that rebuilds `skills` (CREATE new + DROP +
-- RENAME) drops these triggers with the old table and must recreate them;
-- src/tests/skill-search.test.ts asserts they exist on the migrated schema.
CREATE TRIGGER IF NOT EXISTS skills_fts_insert
AFTER INSERT ON skills
BEGIN
  INSERT INTO skills_fts(skill_id, name, description, content)
    VALUES (NEW.id, NEW.name, NEW.description, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS skills_fts_update
AFTER UPDATE OF id, name, description, content ON skills
BEGIN
  DELETE FROM skills_fts WHERE skill_id = OLD.id;
  INSERT INTO skills_fts(skill_id, name, description, content)
    VALUES (NEW.id, NEW.name, NEW.description, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS skills_fts_delete
AFTER DELETE ON skills
BEGIN
  DELETE FROM skills_fts WHERE skill_id = OLD.id;
END;
