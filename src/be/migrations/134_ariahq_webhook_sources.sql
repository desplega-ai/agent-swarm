ALTER TABLE ariahq_knowledge_sources ADD COLUMN webhookSecretHash TEXT;

CREATE INDEX idx_ariahq_knowledge_sources_webhook_secret
  ON ariahq_knowledge_sources(id, webhookSecretHash)
  WHERE adapter = 'webhook' AND enabled = 1;
