const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function fixProjectsTable() {
  try {
    const client = await pool.connect();
    console.log('检查 projects 表结构...\n');

    const result = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'projects'
      ORDER BY ordinal_position;
    `);

    console.log('Projects 表字段:');
    result.rows.forEach(row => {
      console.log(`  ${row.column_name}: ${row.data_type}`);
    });

    // 检查是否有end_date字段
    const hasEndDate = result.rows.some(row => row.column_name === 'end_date');
    if (!hasEndDate) {
      console.log('\n⚠️  缺少 end_date 字段，正在添加...');
      await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_date DATE');
      console.log('✓ end_date 字段已添加');
    } else {
      console.log('\n✓ end_date 字段已存在');
    }

    client.release();
    await pool.end();
  } catch (err) {
    console.error('检查失败:', err.message);
    await pool.end();
    process.exit(1);
  }
}

fixProjectsTable();
