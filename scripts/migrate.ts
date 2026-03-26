import { Pool } from 'pg'

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '11111a',
})

async function migrate() {
  const client = await pool.connect()
  try {
    await client.query('CREATE DATABASE gantt_db')
    console.log('Created database gantt_db')
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P04') {
      console.log('Database gantt_db already exists')
    } else {
      throw err
    }
  } finally {
    client.release()
  }
  await pool.end()

  const dbPool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'gantt_db',
    user: 'postgres',
    password: '11111a',
  })

  const dbClient = await dbPool.connect()
  try {
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        start_date DATE,
        end_date DATE,
        status_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        parent_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        name VARCHAR(255) NOT NULL,
        assignee VARCHAR(100),
        start_date TIMESTAMPTZ,
        end_date TIMESTAMPTZ,
        duration NUMERIC,
        duration_unit VARCHAR(20) DEFAULT 'day',
        percent_done NUMERIC DEFAULT 0,
        is_milestone BOOLEAN DEFAULT false,
        note TEXT,
        order_index INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS dependencies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        from_task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
        to_task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
        type INTEGER DEFAULT 2,
        lag NUMERIC DEFAULT 0
      );
    `)
    // Add new columns to existing tables (idempotent)
    await dbClient.query(`
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee VARCHAR(100);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_code VARCHAR(20);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false NOT NULL;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS auto_schedule BOOLEAN DEFAULT true NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_task_code ON tasks(project_id, task_code) WHERE task_code IS NOT NULL;
    `)

    // Task lifecycle table
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS task_lifecycle (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL,
        task_code VARCHAR(20) NOT NULL,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        event_type VARCHAR(30) NOT NULL,
        field_name VARCHAR(50),
        old_value TEXT,
        new_value TEXT,
        description TEXT NOT NULL,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_task_lifecycle_task ON task_lifecycle(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_lifecycle_project ON task_lifecycle(project_id, created_at DESC);
    `)
    // Version history table
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS project_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        snapshot JSONB NOT NULL,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_project_versions_project
        ON project_versions(project_id, version_number DESC);

      CREATE TABLE IF NOT EXISTS change_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version_id UUID NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
        change_type VARCHAR(30) NOT NULL,
        task_name VARCHAR(255),
        field_name VARCHAR(50),
        old_value TEXT,
        new_value TEXT,
        description TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_change_logs_version
        ON change_logs(version_id);
    `)
    console.log('Schema migration complete')
  } finally {
    dbClient.release()
    await dbPool.end()
  }
}

migrate().catch(console.error)
