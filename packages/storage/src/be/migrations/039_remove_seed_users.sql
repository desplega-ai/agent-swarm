-- Migration 039: Remove hardcoded seed users from migration 031
-- Re-add via scripts/backfill-seed-users.sql after deploy
DELETE FROM users WHERE email IN ('t@desplega.ai', 'e@desplega.ai');
