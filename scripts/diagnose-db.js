const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function diagnoseDatabase() {
  try {
    const client = await pool.connect();
    console.log('📊 数据库诊断\n');

    // 检查最新创建的任务
    const tasksResult = await client.query(`
      SELECT id, name, task_code, start_date, end_date, duration, auto_schedule
      FROM tasks
      WHERE is_deleted = false
      ORDER BY created_at DESC
      LIMIT 10
    `);

    console.log('最近创建的任务:');
    console.log('ID'.padEnd(38), '名称'.padEnd(20), '开始日期'.padEnd(12), '结束日期'.padEnd(12), '工期');
    console.log('-'.repeat(100));

    tasksResult.rows.forEach(task => {
      const id = task.id.substring(0, 36);
      const name = task.name?.substring(0, 18) || '';
      const start = task.start_date || 'NULL';
      const end = task.end_date || 'NULL';
      const duration = task.duration || 'NULL';
      console.log(
        id.padEnd(38),
        name.padEnd(20),
        String(start).padEnd(12),
        String(end).padEnd(12),
        String(duration)
      );
    });

    // 检查依赖关系
    const depsResult = await client.query(`
      SELECT d.id, d.from_task_id, ft.name as from_name, d.to_task_id, tt.name as to_name, d.type, d.lag
      FROM dependencies d
      JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
      JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
      ORDER BY d.created_at DESC
      LIMIT 10
    `);

    console.log('\n依赖关系:');
    console.log('ID'.padEnd(38), '前置任务'.padEnd(20), '后继任务'.padEnd(20), '类型', '滞后');
    console.log('-'.repeat(100));

    depsResult.rows.forEach(dep => {
      const id = dep.id.substring(0, 36);
      const fromName = dep.from_name?.substring(0, 18) || '';
      const toName = dep.to_name?.substring(0, 18) || '';
      const type = dep.type === 2 ? 'FS' : String(dep.type);
      const lag = dep.lag || 0;
      console.log(
        id.padEnd(38),
        fromName.padEnd(20),
        toName.padEnd(20),
        type.padEnd(4),
        String(lag)
      );
    });

    // 手动测试级联更新
    console.log('\n🔧 手动测试级联更新:');

    // 找一个有依赖关系的项目
    const projectTasks = await client.query(`
      SELECT t.id, t.name, t.start_date, t.end_date, t.project_id
      FROM tasks t
      JOIN dependencies d ON (d.from_task_id = t.id OR d.to_task_id = t.id)
      WHERE t.is_deleted = false
      LIMIT 4
    `);

    if (projectTasks.rows.length >= 2) {
      const task1 = projectTasks.rows[0];
      const task2 = projectTasks.rows[1];

      console.log(`任务1: ${task1.name} (${task1.start_date} ~ ${task1.end_date})`);
      console.log(`任务2: ${task2.name} (${task2.start_date} ~ ${task2.end_date})`);

      // 模拟级联更新：将任务1的结束日期延后5天
      const newEndDate = '2026-03-27';
      console.log(`\n将任务1结束日期改为: ${newEndDate}`);

      // 调用级联更新逻辑
      const { cascadeFsDependencies } = require('./test-cascade');
      const cascadedIds = await cascadeFsDependencies(client, task1.project_id);

      console.log(`级联更新影响的任务数量: ${cascadedIds.length}`);

      // 检查更新后的任务
      const updatedTasks = await client.query(`
        SELECT id, name, start_date, end_date
        FROM tasks
        WHERE id IN ($1, $2)
      `, [task1.id, task2.id]);

      console.log('\n更新后的任务:');
      updatedTasks.rows.forEach(t => {
        console.log(`${t.name}: ${t.start_date} ~ ${t.end_date}`);
      });
    }

    client.release();
    await pool.end();

  } catch (err) {
    console.error('诊断失败:', err.message);
    await pool.end();
    process.exit(1);
  }
}

diagnoseDatabase();
