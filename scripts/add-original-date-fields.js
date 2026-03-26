/**
 * 添加 original_start_date 和 original_end_date 字段到 tasks 表
 * 用于保存任务成为摘要任务之前的原始工作日期
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function addOriginalDateFields() {
  const client = await pool.connect();
  try {
    console.log('正在添加 original_start_date 和 original_end_date 字段...\n');

    // 添加字段
    await client.query(`
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS original_start_date DATE,
      ADD COLUMN IF NOT EXISTS original_end_date DATE
    `);
    console.log('✓ 字段添加成功');

    // 验证字段已添加
    const columns = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'tasks'
      AND column_name IN ('original_start_date', 'original_end_date')
    `);

    console.log('\n📊 已添加的字段:');
    columns.rows.forEach(col => {
      console.log(`  - ${col.column_name}: ${col.data_type}`);
    });

    console.log('\n✅ 数据库更新完成！');

  } catch (err) {
    console.error('❌ 添加字段失败:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

addOriginalDateFields();
