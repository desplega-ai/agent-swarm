-- Phase 1 of memory-graph recall-edges: contextKey threading, intent capture,
-- memory-get retrieval events, and deterministic typed links.

-- 1. Add contextKey to agent_memory (born-under context)
ALTER TABLE agent_memory ADD COLUMN contextKey TEXT;
CREATE INDEX idx_agent_memory_context_key ON agent_memory(contextKey);

-- 2. Extend memory_retrieval with contextKey, intent, and eventType
ALTER TABLE memory_retrieval ADD COLUMN contextKey TEXT;
ALTER TABLE memory_retrieval ADD COLUMN intent TEXT;
ALTER TABLE memory_retrieval ADD COLUMN eventType TEXT NOT NULL DEFAULT 'search'
    CHECK (eventType IN ('search', 'get'));
CREATE INDEX idx_memret_context_key ON memory_retrieval(contextKey);
CREATE INDEX idx_memret_event_type ON memory_retrieval(eventType);

-- 3. Add contextKey to memory_rating
ALTER TABLE memory_rating ADD COLUMN contextKey TEXT;
CREATE INDEX idx_memrat_context_key ON memory_rating(contextKey);

-- 4. New table: memory_link — deterministic typed links between memories
--    and external entities (agent-fs files, PRs, agent-UI pages, etc.)
CREATE TABLE IF NOT EXISTS memory_link (
    id             TEXT PRIMARY KEY,
    from_memory_id TEXT NOT NULL,
    linkType       TEXT NOT NULL CHECK (
        linkType IN (
            'wikilink',
            'sequel',
            'agent-fs-file',
            'agent-ui',
            'pr',
            'external-source'
        )
    ),
    targetKind     TEXT NOT NULL CHECK (
        targetKind IN ('memory', 'agent-fs-file', 'agent-ui', 'pr', 'external-source')
    ),
    targetId       TEXT NOT NULL,
    strength       REAL NOT NULL DEFAULT 1.0,
    resolver       TEXT NOT NULL,
    sourceText     TEXT,
    metadata       TEXT,
    createdAt      TEXT NOT NULL,
    updatedAt      TEXT NOT NULL,
    UNIQUE (from_memory_id, linkType, targetKind, targetId, sourceText),
    FOREIGN KEY (from_memory_id) REFERENCES agent_memory(id) ON DELETE CASCADE
);
CREATE INDEX idx_memlink_from ON memory_link(from_memory_id);
CREATE INDEX idx_memlink_target ON memory_link(targetKind, targetId);
CREATE INDEX idx_memlink_type ON memory_link(linkType);
