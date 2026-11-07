-- Additive and repeatable; old clients can continue saving without these fields.
BEGIN;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS custom_values JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE task_change_log ALTER COLUMN field TYPE VARCHAR(100);
COMMIT;
