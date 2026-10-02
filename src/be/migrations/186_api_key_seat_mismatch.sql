-- Seat mismatch record for a pooled Claude OAuth credential. The Claude CLI
-- rejects a model the seat cannot run with a rate_limit_event that carries
-- `errorCode: "credits_required"` (for example "Fable 5.1 requires usage
-- credits" on a Claude Team standard seat). That is not a rate limit, so the
-- key stays `available`; these columns show when it happened and for which
-- model family, so the operator can correct a wrong `manual` plan.
ALTER TABLE api_key_status ADD COLUMN lastSeatMismatchAt TEXT;
ALTER TABLE api_key_status ADD COLUMN lastSeatMismatchModel TEXT;
