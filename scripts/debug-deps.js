const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function debugDependencies() {
  try {
    const client = await pool.connect();
    console.log('🔍 调试依赖管理问题\n');

    // 查看最近的任务数据
    const tasksResult = await client.query(`
      SELECT id, name, start_date, end_date, duration, auto_schedule,
        EXTRACT(EPOCH FROM start_date) as start_epoch,
        EXTRACT(EPOCH FROM end_date) as end_epoch
      FROM tasks
      WHERE is_deleted = false
      ORDER BY created_at DESC
      LIMIT 5
    `);

    console.log('最近的任务:');
    tasksResult.rows.forEach(task => {
      const start = task.start_date ? task.start_date.toISOString().split('T')[0] : 'NULL';
      const end = task.end_date ? task.end_date.toISOString().split('T')[0] : 'NULL';
      console.log(`${task.name}: ${start} ~ ${end} (duration: ${task.duration}, auto: ${task.auto_schedule})`);
    });

    // 查看依赖关系
    const depsResult = await client.query(`
      SELECT d.id, d.from_task_id, ft.name as from_name, ft.start_date as from_start, ft.end_date as from_end,
             d.to_task_id, tt.name as to_name, tt.start_date as to_start, tt.end_date as to_end,
             d.type, d.lag
      FROM dependencies d
      JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
      JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
      ORDER BY d.created_at DESC
      LIMIT 5
    `);

    console.log('\n依赖关系:');
    depsResult.rows.forEach(dep => {
      const fromStart = dep.from_start ? dep.from_start.toISOString().split('T')[0] : 'NULL';
      const fromEnd = dep.from_end ? dep.from_end.toISOString().split('T')[0] : 'NULL';
      const toStart = dep.to_start ? dep.to_start.toISOString().split('T')[0] : 'NULL';
      const toEnd = dep.to_end ? dep.to_end.toISOString().split('T')[0] : 'NULL';
      console.log(`${dep.from_name} (${fromStart}~${fromEnd}) → ${dep.to_name} (${toStart}~${toEnd}) [lag: ${dep.lag}]`);
    });

    // 检查日期计算逻辑
    if (depsResult.rows.length > 0) {
      const dep = depsResult.rows[0];
      const fromEnd = new Date(dep.from_end);
      const toStart = new Date(dep.to_start);

      console.log('\n📅 日期计算检查:');
      console.log(`前置任务结束日期: ${fromEnd.toISOString()}`);
      console.log(`后继任务开始日期: ${toStart.toISOString()}`);

      // 计算期望的最小开始日期
      const minStart = new Date(fromEnd);
      minStart.setDate(minStart.getDate() + 1 + (dep.lag || 0));
      console.log(`期望最小开始日期: ${minStart.toISOString().split('T')[0]}`);
      console.log(`实际开始日期: ${toStart.toISOString().split('T')[0]}`);

      const diffTime = toStart.getTime() - fromEnd.getTime();
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
      console.log(`天数差异: ${diffDays} 天`);
    }

    client.release();
    await pool.end();
  } catch (err) {
    console.error('调试失败:', err.message);
    await pool.end();
  }
}

debugDependencies();
