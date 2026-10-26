-- Optional per-script executor override ("native" | "quickjs").
-- When NULL, the deployment's SCRIPT_EXECUTOR default applies.
ALTER TABLE scripts ADD COLUMN executor TEXT DEFAULT NULL;
