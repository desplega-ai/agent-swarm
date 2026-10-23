-- Name + description index for ranked skill search. skills_fts (239) scores
-- the whole row, and FTS5 bm25 length-normalizes over every column, so a
-- long SKILL.md body buries a name or description hit. This index holds only
-- the short fields; searchSkillRowsRanked adds its score to skills_fts's.
-- Column order matters: bm25() weights are positional (skill_id, name,
-- description).
CREATE VIRTUAL TABLE IF NOT EXISTS skills_meta_fts USING fts5(
  skill_id UNINDEXED,
  name,
  description,
  tokenize='porter unicode61'
);

INSERT INTO skills_meta_fts(skill_id, name, description)
  SELECT id, name, description FROM skills
  WHERE id NOT IN (SELECT skill_id FROM skills_meta_fts WHERE skill_id IS NOT NULL);

-- Same sync rules as skills_fts: a later migration that rebuilds `skills`
-- must recreate these triggers; src/tests/skill-search.test.ts asserts them.
CREATE TRIGGER IF NOT EXISTS skills_meta_fts_insert
AFTER INSERT ON skills
BEGIN
  INSERT INTO skills_meta_fts(skill_id, name, description)
    VALUES (NEW.id, NEW.name, NEW.description);
END;

CREATE TRIGGER IF NOT EXISTS skills_meta_fts_update
AFTER UPDATE OF id, name, description ON skills
BEGIN
  DELETE FROM skills_meta_fts WHERE skill_id = OLD.id;
  INSERT INTO skills_meta_fts(skill_id, name, description)
    VALUES (NEW.id, NEW.name, NEW.description);
END;

CREATE TRIGGER IF NOT EXISTS skills_meta_fts_delete
AFTER DELETE ON skills
BEGIN
  DELETE FROM skills_meta_fts WHERE skill_id = OLD.id;
END;
