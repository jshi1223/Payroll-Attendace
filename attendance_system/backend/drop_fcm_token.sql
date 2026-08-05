-- Removes the unused Firebase token column for a local-only setup.
ALTER TABLE employees DROP COLUMN IF EXISTS fcm_token;
