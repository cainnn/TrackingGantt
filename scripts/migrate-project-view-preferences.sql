-- Personal display preferences do not modify the project plan or its versions.
CREATE TABLE IF NOT EXISTS project_view_preferences (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_view JSONB,
  saved_views JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);
