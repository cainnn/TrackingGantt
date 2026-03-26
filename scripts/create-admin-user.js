const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function createAdminUser() {
  try {
    const client = await pool.connect();
    console.log('正在创建默认管理员账号...\n');

    // 生成密码hash
    const password = 'admin123';
    const passwordHash = await bcrypt.hash(password, 10);

    console.log('✓ 密码hash已生成');

    // 删除旧的admin用户（如果存在）
    await client.query('DELETE FROM users WHERE username = $1', ['admin']);
    console.log('✓ 清理旧的admin用户');

    // 插入新的admin用户
    const result = await client.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, created_at`,
      ['admin', 'admin@gantt.app', passwordHash]
    );

    const user = result.rows[0];
    console.log('\n✅ 默认管理员账号创建成功！');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📧 用户名: admin`);
    console.log(`🔑 密码: admin123`);
    console.log(`📧 邮箱: admin@gantt.app`);
    console.log(`🆔 用户ID: ${user.id}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    client.release();
    await pool.end();

    console.log('\n💡 现在可以使用以下账号登录：');
    console.log('   地址: http://localhost:3001/login');
    console.log('   用户名: admin');
    console.log('   密码: admin123');

  } catch (err) {
    console.error('❌ 创建用户失败:', err.message);
    await pool.end();
    process.exit(1);
  }
}

createAdminUser();
