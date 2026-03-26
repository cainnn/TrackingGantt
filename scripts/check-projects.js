const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function checkProjects() {
  try {
    // 查询所有项目
    const projectsResult = await pool.query(`
      SELECT p.id, p.name, p.user_id, u.username, p.created_at
      FROM projects p
      LEFT JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC
    `);

    console.log('\n=== 所有项目 ===');
    console.log('总数:', projectsResult.rows.length);
    projectsResult.rows.forEach(p => {
      console.log(`- ${p.name} (ID: ${p.id}, 用户: ${p.username || 'unknown'}, 创建时间: ${p.created_at})`);
    });

    // 查询admin用户的项目
    const adminProjects = await pool.query(`
      SELECT p.id, p.name
      FROM projects p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE u.username = 'admin'
      ORDER BY p.created_at DESC
    `);

    console.log('\n=== Admin用户的项目 ===');
    console.log('总数:', adminProjects.rows.length);
    adminProjects.rows.forEach(p => {
      console.log(`- ${p.name} (ID: ${p.id})`);
    });

    // 检查是否有名为aaa的项目
    const aaaProject = await pool.query("SELECT * FROM projects WHERE name ILIKE '%aaa%'");
    console.log('\n=== 包含\"aaa\"的项目 ===');
    if (aaaProject.rows.length === 0) {
      console.log('未找到包含"aaa"的项目');
    } else {
      aaaProject.rows.forEach(p => {
        console.log(`- ${p.name} (ID: ${p.id})`);
      });
    }

  } catch (err) {
    console.error('错误:', err.message);
  } finally {
    await pool.end();
  }
}

checkProjects();
