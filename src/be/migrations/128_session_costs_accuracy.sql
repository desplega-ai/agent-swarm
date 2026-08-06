-- Preserve adapter-reported values and future pricing inputs alongside the
-- canonical server-computed session cost. NULL means unavailable or predates this feature.
ALTER TABLE session_costs ADD COLUMN harnessCostUsd REAL;
ALTER TABLE session_costs ADD COLUMN cacheWrite5mTokens INTEGER;
ALTER TABLE session_costs ADD COLUMN cacheWrite1hTokens INTEGER;
ALTER TABLE session_costs ADD COLUMN modelBreakdown TEXT;
