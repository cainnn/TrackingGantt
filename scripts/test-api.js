const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function testNewAPI() {
  const client = await pool.connect();
  try {
    // 模拟API逻辑
    console.log('测试新的API逻辑...\n');

    // 1. 获取admin用户ID
    const userResult = await client.query("SELECT id FROM users WHERE username = 'admin'");
    if (userResult.rows.length === 0) {
      console.log('未找到admin用户');
      return;
    }
    const userId = userResult.rows[0].id;
    console.log('Admin用户ID:', userId);

    // 2. 获取所有项目
    const projectsResult = await client.query(
      'SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    console.log('\n找到项目数:', projectsResult.rows.length);

    // 3. 为每个项目计算进度
    const projects = await Promise.all(
      projectsResult.rows.map(async (p) => {
        console.log(`\n处理项目: ${p.name}`);

        // 计算总工期
        const totalResult = await client.query(
          `SELECT COALESCE(SUM(duration), 0) as total
           FROM tasks
           WHERE project_id = $1
             AND is_deleted = false
             AND start_date IS NOT NULL
             AND end_date IS NOT NULL`,
          [p.id]
        );
        const totalDuration = Number(totalResult.rows[0].total) || 0;
        console.log(`  总工期: ${totalDuration} 天`);

        // 计算已完成工日
        const completedResult = await client.query(
          `SELECT COALESCE(SUM(
             CASE
               WHEN COALESCE($1, CURRENT_DATE) >= end_date THEN duration
               WHEN COALESCE($1, CURRENT_DATE) <= start_date THEN 0
               ELSE GREATEST(0, (COALESCE($1, CURRENT_DATE) - start_date)::int + 1)
             END
           ), 0) as completed
           FROM tasks
           WHERE project_id = $2
             AND is_deleted = false
             AND start_date IS NOT NULL
             AND end_date IS NOT NULL`,
          [p.status_date, p.id]
        );
        const completedDuration = Number(completedResult.rows[0].completed) || 0;
        console.log(`  已完成: ${completedDuration} 天`);

        const progress = totalDuration > 0 ? Math.round((completedDuration / totalDuration) * 100) : 0;
        console.log(`  进度: ${progress}%`);

        return {
          ...p,
          progress,
        };
      })
    );

    console.log('\n=== 最终结果 ===');
    projects.forEach(p => {
      console.log(`- ${p.name}: 进度 ${p.progress}%`);
    });

  } catch (err) {
    console.error('\n错误:', err.message);
    console.error(err.stack);
  } finally {
    client.release();
    await pool.end();
  }
}

testNewAPI();
