const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function manualTest() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('🔧 手动测试依赖管理\n');

    // 创建测试用户
    const userResult = await client.query(`
      INSERT INTO users (username, email, password_hash)
      VALUES ('manual_test', 'manual@test.com', '$2a$10$test')
      RETURNING id
    `);
    const userId = userResult.rows[0].id;
    console.log(`✓ 创建用户: ${userId}`);

    // 创建测试项目
    const projectResult = await client.query(`
      INSERT INTO projects (user_id, name, start_date)
      VALUES ($1, '手动测试项目', '2026-03-20')
      RETURNING id
    `, [userId]);
    const projectId = projectResult.rows[0].id;
    console.log(`✓ 创建项目: ${projectId}`);

    // 创建任务1
    const task1Result = await client.query(`
      INSERT INTO tasks (project_id, name, start_date, end_date, duration, order_index, auto_schedule)
      VALUES ($1, '任务1', '2026-03-20', '2026-03-22', 2, 0, true)
      RETURNING id, name, start_date, end_date, duration
    `, [projectId]);
    const task1 = task1Result.rows[0];
    console.log(`✓ 创建任务1: ${task1.name} (${task1.start_date} ~ ${task1.end_date})`);

    // 创建任务2
    const task2Result = await client.query(`
      INSERT INTO tasks (project_id, name, start_date, end_date, duration, order_index, auto_schedule)
      VALUES ($1, '任务2', '2026-03-23', '2026-03-25', 2, 1, true)
      RETURNING id, name, start_date, end_date, duration
    `, [projectId]);
    const task2 = task2Result.rows[0];
    console.log(`✓ 创建任务2: ${task2.name} (${task2.start_date} ~ ${task2.end_date})`);

    // 创建依赖关系
    console.log('\n创建依赖关系: 任务1 → 任务2');
    const depResult = await client.query(`
      INSERT INTO dependencies (project_id, from_task_id, to_task_id, type, lag)
      VALUES ($1, $2, $3, 2, 0)
      RETURNING id
    `, [projectId, task1.id, task2.id]);
    console.log(`✓ 创建依赖: ${depResult.rows[0].id}`);

    // 检查级联更新前的任务2
    const beforeTask2 = await client.query('SELECT * FROM tasks WHERE id = $1', [task2.id]);
    console.log(`\n级联更新前任务2: ${beforeTask2.rows[0].start_date} ~ ${beforeTask2.rows[0].end_date}`);

    // 手动调用级联更新
    console.log('\n调用 cascadeFsDependencies...');
    const cascadedIds = await cascadeFsDependencies(client, projectId);
    console.log(`级联更新影响: ${cascadedIds.length} 个任务`);

    // 检查级联更新后的任务2
    const afterTask2 = await client.query('SELECT * FROM tasks WHERE id = $1', [task2.id]);
    console.log(`级联更新后任务2: ${afterTask2.rows[0].start_date} ~ ${afterTask2.rows[0].end_date}`);

    // 测试更新任务1日期
    console.log('\n\n测试：将任务1结束日期延迟到 2026-03-27');
    await client.query(`
      UPDATE tasks
      SET start_date = '2026-03-25', end_date = '2026-03-27', duration = 2
      WHERE id = $1
    `, [task1.id]);

    const beforeTask2_2 = await client.query('SELECT * FROM tasks WHERE id = $1', [task2.id]);
    console.log(`级联更新前任务2: ${beforeTask2_2.rows[0].start_date} ~ ${beforeTask2_2.rows[0].end_date}`);

    await cascadeFsDependencies(client, projectId);

    const afterTask2_2 = await client.query('SELECT * FROM tasks WHERE id = $1', [task2.id]);
    console.log(`级联更新后任务2: ${afterTask2_2.rows[0].start_date} ~ ${afterTask2_2.rows[0].end_date}`);

    await client.query('ROLLBACK');
    console.log('\n✓ 测试完成，已回滚');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('测试失败:', err.message);
    console.error(err.stack);
  } finally {
    client.release();
    await pool.end();
  }
}

// 级联更新函数（简化版）
async function cascadeFsDependencies(client, projectId) {
  const cascadedIds = [];

  // 获取所有FS依赖
  const depsRes = await client.query(
    `SELECT d.from_task_id, d.to_task_id, d.lag FROM dependencies d
     JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
     JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
     WHERE d.project_id = $1 AND d.type = 2`,
    [projectId]
  );

  // 获取所有任务
  const tasksRes = await client.query(
    'SELECT id, start_date, end_date, duration, auto_schedule FROM tasks WHERE project_id = $1 AND is_deleted = false',
    [projectId]
  );

  const taskMap = new Map();
  tasksRes.rows.forEach(r => {
    taskMap.set(r.id, {
      start_date: r.start_date,
      end_date: r.end_date,
      duration: r.duration,
      auto_schedule: r.auto_schedule !== false
    });
  });

  // 日期辅助函数
  const parseDate = (s) => s ? new Date(s) : null;
  const addDays = (dateStr, days) => {
    const d = parseDate(dateStr);
    if (!d) return null;
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };
  const diffDays = (a, b) => {
    const da = parseDate(a);
    const db = parseDate(b);
    if (!da || !db) return 0;
    return Math.round((db.getTime() - da.getTime()) / 86400000);
  };

  let changed = true;
  let iterations = 0;
  const maxIterations = 100;

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    for (const dep of depsRes.rows) {
      const from = taskMap.get(dep.from_task_id);
      const to = taskMap.get(dep.to_task_id);

      if (!from?.end_date || !to?.start_date) continue;
      if (!to.auto_schedule) {
        console.log(`跳过任务 ${dep.to_task_id}: auto_schedule = false`);
        continue;
      }

      const minStart = addDays(from.end_date, 1 + (dep.lag || 0));
      if (!minStart) continue;

      console.log(`检查依赖 ${dep.from_task_id} -> ${dep.to_task_id}:`);
      console.log(`  前置结束: ${from.end_date}, 后继开始: ${to.start_date}, 最小开始: ${minStart}`);

      if (to.start_date >= minStart) {
        console.log(`  → 无需调整 (${to.start_date} >= ${minStart})`);
        continue;
      }

      const shift = diffDays(to.start_date, minStart);
      const newStart = minStart;
      const newEnd = addDays(to.end_date, shift);

      console.log(`  → 需要调整: ${to.start_date} -> ${newStart}, ${to.end_date} -> ${newEnd}`);

      await client.query(
        `UPDATE tasks SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW()
         WHERE id = $4 AND project_id = $5`,
        [newStart, newEnd, diffDays(newStart, newEnd), dep.to_task_id, projectId]
      );

      cascadedIds.push(dep.to_task_id);
      taskMap.set(dep.to_task_id, {
        start_date: newStart,
        end_date: newEnd,
        duration: diffDays(newStart, newEnd),
        auto_schedule: to.auto_schedule
      });
      changed = true;
    }
  }

  console.log(`级联更新完成: ${iterations} 次迭代`);
  return cascadedIds;
}

manualTest();
