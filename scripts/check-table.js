const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function checkTable() {
  try {
    const client = await pool.connect();
    console.log('检查 users 表结构...\n');

    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'users'
      ORDER BY ordinal_position;
    `);

    console.log('Users 表字段:');
    result.rows.forEach(row => {
      console.log(`  ${row.column_name}: ${row.data_type} (nullable: ${row.is_nullable})`);
    });

    // 检查是否有email字段
    const hasEmail = result.rows.some(row => row.column_name === 'email');
    if (!hasEmail) {
      console.log('\n⚠️  缺少 email 字段，正在添加...');
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');
      console.log('✓ email 字段已添加');
    } else {
      console.log('\n✓ email 字段已存在');
    }

    client.release();
    await pool.end();
  } catch (err) {
    console.error('检查失败:', err.message);
    await pool.end();
    process.exit(1);
  }
}

checkTable();
