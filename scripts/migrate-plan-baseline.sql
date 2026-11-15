ALTER TABLE projects ADD COLUMN IF NOT EXISTS plan_baseline jsonb;
CREATE TABLE IF NOT EXISTS project_baseline_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  baseline_id uuid NOT NULL,
  previous_baseline jsonb,
  baseline jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, baseline_id)
);
