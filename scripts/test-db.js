const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: '11111a',
});

async function testConnection() {
  try {
    console.log('正在连接到 PostgreSQL...');
    const client = await pool.connect();
    console.log('✓ 数据库连接成功！');

    // 检查是否有 gantt_app 数据库
    const dbCheck = await client.query(
      "SELECT datname FROM pg_database WHERE datname = 'gantt_app'"
    );

    if (dbCheck.rows.length === 0) {
      console.log('创建 gantt_app 数据库...');
      await client.query('CREATE DATABASE gantt_app');
      console.log('✓ 数据库创建成功！');
    } else {
      console.log('✓ gantt_app 数据库已存在');
    }

    client.release();

    // 连接到 gantt_app 数据库
    const appPool = new Pool({
      host: 'localhost',
      port: 5432,
      database: 'gantt_app',
      user: 'postgres',
      password: '11111a',
    });

    const appClient = await appPool.connect();
    console.log('✓ 已连接到 gantt_app 数据库');

    // 检查必要的表是否存在
    const tables = await appClient.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('users', 'projects', 'tasks', 'dependencies')
      ORDER BY table_name;
    `);

    console.log('现有数据表：', tables.rows.map(r => r.table_name));

    const requiredTables = ['users', 'projects', 'tasks', 'dependencies'];
    const missingTables = requiredTables.filter(
      t => !tables.rows.find(r => r.table_name === t)
    );

    if (missingTables.length > 0) {
      console.log('缺少以下表：', missingTables);
      console.log('需要运行数据库初始化脚本');
    } else {
      console.log('✓ 所有必要的表都存在');
    }

    // 检查是否有测试数据
    const projectCount = await appClient.query('SELECT COUNT(*) FROM projects');
    const taskCount = await appClient.query('SELECT COUNT(*) FROM tasks WHERE is_deleted = false');
    const depCount = await appClient.query('SELECT COUNT(*) FROM dependencies');

    console.log(`项目数: ${projectCount.rows[0].count}`);
    console.log(`任务数: ${taskCount.rows[0].count}`);
    console.log(`依赖关系数: ${depCount.rows[0].count}`);

    appClient.release();
    await appPool.end();
    await pool.end();

  } catch (err) {
    console.error('数据库连接失败：', err.message);
    console.log('请确保：');
    console.log('1. PostgreSQL 18 正在运行');
    console.log('2. 用户名: postgres, 密码: 11111a');
    console.log('3. 端口: 5432');
    process.exit(1);
  }
}

testConnection();
