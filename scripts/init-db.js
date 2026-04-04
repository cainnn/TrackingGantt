const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = Number(process.env.DB_PORT || 5432);
const DB_NAME = process.env.DB_NAME || 'gantt_app';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD || process.env.DB_PASSWORD || '';

const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
});

async function ensureDatabaseExists() {
  const adminPool = new Pool({
    host: DB_HOST,
    port: DB_PORT,
    database: 'postgres',
    user: DB_USER,
    password: DB_PASSWORD,
  });

  const client = await adminPool.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (exists.rows.length > 0) return;

    console.log(`数据库不存在，正在创建：${DB_NAME} ...`);
    await client.query(`CREATE DATABASE ${DB_NAME}`);
    console.log('✓ 数据库已创建');
  } finally {
    client.release();
    await adminPool.end();
  }
}

async function initDatabase() {
  try {
    console.log('正在初始化数据库...');
    await ensureDatabaseExists();
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
      console.log(`  密码: admin123`);
      console.log(`  \n提示：也可以访问 http://localhost:3000/register 注册新账号`);
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
