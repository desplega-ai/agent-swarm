ALTER TABLE ariahq_slack_surfaces ADD COLUMN verificationStatus TEXT NOT NULL DEFAULT 'pending'
  CHECK (verificationStatus IN ('pending', 'verified', 'failed'));
ALTER TABLE ariahq_slack_surfaces ADD COLUMN verifiedAt TEXT;
ALTER TABLE ariahq_slack_surfaces ADD COLUMN verificationError TEXT;

UPDATE ariahq_slack_surfaces SET isActive = 0, verificationStatus = 'pending';

CREATE INDEX idx_ariahq_slack_surfaces_verification
  ON ariahq_slack_surfaces(organizationId, verificationStatus, isActive);
