const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function testDateStorage() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('🔍 测试日期存储\n');

    // 创建测试用户和项目
    const userResult = await client.query(`
      INSERT INTO users (username, email, password_hash)
      VALUES ('date_test', 'date@test.com', '$2a$10$test')
      ON CONFLICT (username) DO NOTHING
      RETURNING id
    `);

    const userId = userResult.rows.length > 0 ? userResult.rows[0].id :
      (await client.query('SELECT id FROM users WHERE username = $1', ['date_test'])).rows[0].id;

    const projectResult = await client.query(`
      INSERT INTO projects (user_id, name, start_date)
      VALUES ($1, '日期测试', '2026-03-20')
      RETURNING id
    `, [userId]);

    const projectId = projectResult.rows[0].id;

    // 创建任务，使用不同的日期格式
    const testCases = [
      { name: '任务1-字符串', start: '2026-03-20', end: '2026-03-22' },
      { name: '任务2-Date对象', start: new Date('2026-03-23'), end: new Date('2026-03-25') },
      { name: '任务3-ISO字符串', start: '2026-03-26T00:00:00.000Z', end: '2026-03-28T00:00:00.000Z' }
    ];

    for (const tc of testCases) {
      const result = await client.query(`
        INSERT INTO tasks (project_id, name, start_date, end_date, duration, order_index)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, name, start_date, end_date,
          EXTRACT(EPOCH FROM start_date) as start_epoch,
          EXTRACT(EPOCH FROM end_date) as end_epoch
      `, [projectId, tc.name, tc.start, tc.end, 2, 0]);

      const task = result.rows[0];
      const startStr = task.start_date instanceof Date
        ? task.start_date.toISOString().split('T')[0]
        : String(task.start_date);
      const endStr = task.end_date instanceof Date
        ? task.end_date.toISOString().split('T')[0]
        : String(task.end_date);

      console.log(`${task.name}:`);
      console.log(`  输入: start=${tc.start}, end=${tc.end}`);
      console.log(`  存储: start=${startStr} (epoch: ${task.start_epoch}), end=${endStr} (epoch: ${task.end_epoch})`);
      console.log(`  类型: start=${typeof task.start_date}, end=${typeof task.end_date}`);
    }

    // 查询所有任务看看实际存储的日期
    const allTasks = await client.query(`
      SELECT name, start_date, end_date,
        EXTRACT(EPOCH FROM start_date) as start_epoch,
        EXTRACT(EPOCH FROM end_date) as end_epoch
      FROM tasks
      WHERE project_id = $1
      ORDER BY order_index
    `, [projectId]);

    console.log('\n📋 数据库中存储的日期:');
    allTasks.rows.forEach(task => {
      const startStr = task.start_date instanceof Date
        ? task.start_date.toISOString().split('T')[0]
        : String(task.start_date);
      const endStr = task.end_date instanceof Date
        ? task.end_date.toISOString().split('T')[0]
        : String(task.end_date);
      console.log(`${task.name}: ${startStr} ~ ${endStr}`);
    });

    await client.query('ROLLBACK');
    console.log('\n✓ 测试完成，已回滚');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('测试失败:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

testDateStorage();
