BEGIN;
SELECT pg_advisory_xact_lock(hashtext('gantt-project-memberships-v1'));

CREATE TABLE IF NOT EXISTS app_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_memberships (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_memberships_user ON project_memberships(user_id);

CREATE OR REPLACE FUNCTION associate_project_creator()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO project_memberships (project_id, user_id) VALUES (NEW.id, NEW.user_id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS associate_project_creator ON projects;
CREATE TRIGGER associate_project_creator AFTER INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION associate_project_creator();

-- Backfill once. A later deployment must not restore a revoked creator membership
-- or overwrite a password that root has since changed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_migrations WHERE name = 'project-memberships-v1') THEN
    INSERT INTO project_memberships (project_id, user_id)
      SELECT id, user_id FROM projects ON CONFLICT DO NOTHING;

    INSERT INTO users (username, email, password_hash, role)
    VALUES ('root', 'root@gantt.local', '$2b$10$PAdOBgjckyHOzaayF6eXNuR/pfcLQDReH1ygiJ/2bnLqiMq8lduQW', 'administrator')
    ON CONFLICT (username) DO UPDATE SET role = 'administrator', password_hash = EXCLUDED.password_hash;

    INSERT INTO app_migrations (name) VALUES ('project-memberships-v1');
  END IF;
END;
$$;
COMMIT;
