const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function createVersionTables() {
  try {
    const client = await pool.connect();
    console.log('正在创建版本管理相关的数据表...\n');

    // 创建 project_versions 表
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        snapshot JSONB NOT NULL,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, version_number)
      )
    `);
    console.log('✓ project_versions 表已创建');

    // 创建 change_logs 表
    await client.query(`
      CREATE TABLE IF NOT EXISTS change_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version_id UUID NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
        change_type VARCHAR(50) NOT NULL,
        task_name VARCHAR(255),
        field_name VARCHAR(100),
        old_value TEXT,
        new_value TEXT,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ change_logs 表已创建');

    // 创建索引以提高查询性能
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_versions_project_id ON project_versions(project_id)
    `);
    console.log('✓ project_versions 索引已创建');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_change_logs_project_id ON change_logs(project_id)
    `);
    console.log('✓ change_logs project_id 索引已创建');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_change_logs_version_id ON change_logs(version_id)
    `);
    console.log('✓ change_logs version_id 索引已创建');

    // 显示创建的表信息
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('project_versions', 'change_logs')
      ORDER BY table_name
    `);

    console.log('\n📊 已创建的表:');
    tables.rows.forEach(t => {
      console.log('  -', t.table_name);
    });

    client.release();
    await pool.end();
    console.log('\n✅ 版本管理表创建完成！现在可以保存版本了。');

  } catch (err) {
    console.error('❌ 创建表失败:', err.message);
    await pool.end();
    process.exit(1);
  }
}

createVersionTables();
