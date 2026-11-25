CREATE TABLE bus_events (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload jsonb NOT NULL,
  "createdAt" bigint NOT NULL
);
CREATE INDEX idx_bus_events_created ON bus_events ("createdAt");
CREATE TABLE bus_deliveries (
  "eventId" TEXT NOT NULL REFERENCES bus_events(id) ON DELETE CASCADE,
  "groupName" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'delivered')),
  attempts bigint NOT NULL DEFAULT 0,
  "claimedBy" TEXT,
  "leaseExpiresAt" bigint,
  "availableAt" bigint NOT NULL,
  "deliveredAt" bigint,
  PRIMARY KEY ("eventId", "groupName")
);
CREATE INDEX idx_bus_deliveries_claim ON bus_deliveries ("groupName", status, "availableAt", "leaseExpiresAt");
