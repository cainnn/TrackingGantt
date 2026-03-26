const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function simpleCheck() {
  try {
    const client = await pool.connect();
    console.log('📊 检查最近创建的任务\n');

    const result = await client.query(`
      SELECT id, name, start_date, end_date, duration,
        EXTRACT(EPOCH FROM start_date) as start_epoch,
        EXTRACT(EPOCH FROM end_date) as end_epoch
      FROM tasks
      WHERE is_deleted = false
      ORDER BY created_at DESC
      LIMIT 5
    `);

    console.log('ID | 名称 | 开始日期 | 结束日期 | 工期');
    console.log('-'.repeat(80));

    result.rows.forEach(task => {
      const start = task.start_date ? task.start_date.toISOString().split('T')[0] : 'NULL';
      const end = task.end_date ? task.end_date.toISOString().split('T')[0] : 'NULL';
      console.log(`${task.id.substring(0, 8)}... | ${task.name} | ${start} | ${end} | ${task.duration}`);
    });

    client.release();
    await pool.end();
  } catch (err) {
    console.error('检查失败:', err.message);
    await pool.end();
  }
}

simpleCheck();
