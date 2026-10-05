-- Generated legacy keys are per-row identities, not document identities.
-- They cannot be safely grouped; preserve them. Keyed documents share
-- (scope, owner, key), matching idx_agent_memory_key.
-- FTS/vector startup reconciliation removes index entries for deleted rows.
DELETE FROM agent_memory AS chunk
WHERE chunk.key IS NOT NULL
  AND chunk.key != chunk.scope || '/' || chunk.source || '/' || chunk.id
  AND NOT EXISTS (
    SELECT 1 FROM agent_memory AS head
    WHERE head.key = chunk.key
      AND head.scope = chunk.scope
      AND COALESCE(head.agentId, '') = COALESCE(chunk.agentId, '')
      AND head.chunkIndex = 0
      AND chunk.chunkIndex < head.totalChunks
  );
