const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function cleanTestData() {
  try {
    const client = await pool.connect();
    console.log('🧹 清理测试数据...\n');

    // 删除测试项目（会级联删除相关的任务和依赖）
    const result = await client.query(`
      DELETE FROM projects
      WHERE name LIKE '%测试%' OR name LIKE '%test%'
      RETURNING id, name
    `);

    console.log(`删除了 ${result.rows.length} 个测试项目:`);
    result.rows.forEach(row => {
      console.log(`  - ${row.name} (ID: ${row.id})`);
    });

    // 删除测试用户
    const userResult = await client.query(`
      DELETE FROM users
      WHERE username LIKE 'test_user%' OR email LIKE '%@test.com'
      RETURNING username
    `);

    console.log(`\n删除了 ${userResult.rows.length} 个测试用户:`);
    userResult.rows.forEach(row => {
      console.log(`  - ${row.username}`);
    });

    // 显示剩余数据统计
    const stats = await client.query(`
      SELECT
        'Projects' AS type, COUNT(*) AS count FROM projects
      UNION ALL
      SELECT 'Users', COUNT(*) FROM users
      UNION ALL
      SELECT 'Tasks', COUNT(*) FROM tasks WHERE is_deleted = false
      UNION ALL
      SELECT 'Dependencies', COUNT(*) FROM dependencies
    `);

    console.log('\n📊 剩余数据统计:');
    stats.rows.forEach(row => {
      console.log(`  ${row.type}: ${row.count}`);
    });

    client.release();
    await pool.end();
    console.log('\n✅ 清理完成');
  } catch (err) {
    console.error('清理失败:', err.message);
    await pool.end();
    process.exit(1);
  }
}

cleanTestData();
