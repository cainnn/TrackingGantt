const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function initDatabase() {
  try {
    console.log('正在初始化数据库...');
    const client = await pool.connect();
    console.log('✓ 已连接到数据库');

    // 读取SQL文件
    const sqlFile = path.join(__dirname, 'init-db.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    // 执行SQL
    console.log('正在执行SQL脚本...');
    await client.query(sql);
    console.log('✓ 数据库初始化完成');

    // 显示测试数据
    const result = await client.query(`
      SELECT
        'Users' AS type, COUNT(*) AS count FROM users
      UNION ALL
      SELECT 'Projects', COUNT(*) FROM projects
      UNION ALL
      SELECT 'Tasks', COUNT(*) FROM tasks WHERE is_deleted = false
      UNION ALL
      SELECT 'Dependencies', COUNT(*) FROM dependencies
    `);

    console.log('\n数据统计：');
    result.rows.forEach(row => {
      console.log(`  ${row.type}: ${row.count}`);
    });

    // 显示测试账号信息
    const users = await client.query('SELECT username FROM users LIMIT 1');
    if (users.rows.length > 0) {
      console.log(`\n测试账号：`);
      console.log(`  用户名: ${users.rows[0].username}`);
      console.log(`  密码: 任意密码（需要先注册）`);
      console.log(`  \n提示：请先访问 http://localhost:3000/register 注册新账号`);
    }

    client.release();
    await pool.end();

  } catch (err) {
    console.error('数据库初始化失败：', err.message);
    await pool.end();
    process.exit(1);
  }
}

initDatabase();
