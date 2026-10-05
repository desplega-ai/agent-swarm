-- One entry per accepted answer to an approval request: who answered (derived
-- from the credential, never from the request body), whether they approved,
-- their answers, and any unverified `respondedBy` claim the client sent.
-- Lets a request whose approvers policy is `all` or `{ min: N }` collect
-- several answers before it resolves. NULL until the first answer.
ALTER TABLE approval_requests ADD COLUMN approvals TEXT;
