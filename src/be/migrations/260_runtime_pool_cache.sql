-- NULL preserves the ephemeral-only behavior of existing pools.
ALTER TABLE runtime_pools ADD COLUMN cache TEXT
  CHECK (cache IS NULL OR json_valid(cache));
