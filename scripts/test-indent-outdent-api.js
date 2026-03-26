/**
 * 测试任务降级后再升级（通过API）
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function testIndentOutdentAPI() {
  const client = await pool.connect();
  let userId, projectId, task1Id, task2Id;

  try {
    await client.query('BEGIN');
    console.log('🧪 测试：降级→升级循环（直接调用API逻辑）\n');

    // 1. 获取测试用户
    const userRes = await client.query('SELECT id FROM users WHERE username = $1', ['admin']);
    userId = userRes.rows[0].id;

    // 2. 创建项目
    const projectRes = await client.query(
      `INSERT INTO projects (name, user_id, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING id`,
      ['测试', userId, '2026-03-20', '2026-03-28']
    );
    projectId = projectRes.rows[0].id;

    // 3. 创建任务T-001 (2026-03-20 ~ 2026-03-22)
    const task1Res = await client.query(
      `INSERT INTO tasks (project_id, name, start_date, end_date, duration, order_index) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [projectId, 'T-001', '2026-03-20', '2026-03-22', 2, 0]
    );
    task1Id = task1Res.rows[0].id;

    // 4. 创建任务T-002 (2026-03-25 ~ 2026-03-28)
    const task2Res = await client.query(
      `INSERT INTO tasks (project_id, name, start_date, end_date, duration, order_index) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [projectId, 'T-002', '2026-03-25', '2026-03-28', 3, 1]
    );
    task2Id = task2Res.rows[0].id;

    const formatDate = (d) => {
      if (!d) return null;
      if (typeof d === 'string') return d.split('T')[0];
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const showTasks = async (msg) => {
      console.log(`\n${msg}`);
      const tasks = await client.query(
        `SELECT id, name, start_date, end_date, parent_id, original_start_date, original_end_date
         FROM tasks WHERE id IN ($1, $2)`,
        [task1Id, task2Id]
      );
      tasks.rows.forEach(t => {
        const parent = t.parent_id === task1Id ? 'T-001' : (t.parent_id ? '未知' : '无');
        const orig = t.original_start_date ? ` (原始: ${formatDate(t.original_start_date)}~${formatDate(t.original_end_date)})` : '';
        console.log(`  ${t.name}: ${formatDate(t.start_date)} ~ ${formatDate(t.end_date)}, parent: ${parent}${orig}`);
      });
    };

    await showTasks('初始状态');

    // ============ 模拟 updateSummaryTaskDateRecursive 函数 ============
    const updateSummaryTaskDateRecursive = async (taskId) => {
      const childrenRes = await client.query(
        `SELECT id, start_date, end_date FROM tasks WHERE parent_id = $1 AND is_deleted = false ORDER BY start_date ASC`,
        [taskId]
      );

      const currentRes = await client.query(
        'SELECT id, start_date, end_date, duration, parent_id, original_start_date, original_end_date FROM tasks WHERE id = $1',
        [taskId]
      );

      const current = currentRes.rows[0];
      if (!current) return null;

      if (childrenRes.rows.length === 0) {
        // 没有子任务了，如果保存了原始日期，则恢复
        if (current.original_start_date && current.original_end_date) {
          console.log(`    → 任务 ${taskId} 没有子任务了，恢复原始日期`);
          const diffDays = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
          const newDuration = diffDays(current.original_start_date, current.original_end_date);

          await client.query(
            `UPDATE tasks SET start_date = $1, end_date = $2, duration = $3,
             original_start_date = NULL, original_end_date = NULL, updated_at = NOW() WHERE id = $4`,
            [current.original_start_date, current.original_end_date, newDuration, taskId]
          );

          const updated = {
            id: current.id,
            start_date: current.original_start_date,
            end_date: current.original_end_date,
            duration: newDuration,
          };

          if (current.parent_id) {
            await updateSummaryTaskDateRecursive(current.parent_id);
          }

          return updated;
        }
        return null;
      }

      // 有子任务，计算时间范围
      let minStart = current.start_date;
      let maxEnd = current.end_date;

      for (const child of childrenRes.rows) {
        if (child.start_date < minStart) minStart = child.start_date;
        if (child.end_date > maxEnd) maxEnd = child.end_date;
      }

      // 检查是否需要更新
      if (current.start_date === minStart && current.end_date === maxEnd) {
        if (current.parent_id) {
          return await updateSummaryTaskDateRecursive(current.parent_id);
        }
        return null;
      }

      // 首次成为摘要任务时，保存原始日期
      const shouldSaveOriginal = !current.original_start_date && !current.original_end_date;
      if (shouldSaveOriginal) {
        console.log(`    → 任务 ${taskId} 首次成为摘要任务，保存原始日期: ${formatDate(current.start_date)}~${formatDate(current.end_date)}`);
      }

      const diffDays = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
      const newDuration = diffDays(minStart, maxEnd);

      if (shouldSaveOriginal) {
        await client.query(
          `UPDATE tasks SET start_date = $1, end_date = $2, duration = $3,
           original_start_date = $4, original_end_date = $5, updated_at = NOW() WHERE id = $6`,
          [minStart, maxEnd, newDuration, current.start_date, current.end_date, taskId]
        );
      } else {
        await client.query(
          `UPDATE tasks SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW() WHERE id = $4`,
          [minStart, maxEnd, newDuration, taskId]
        );
      }

      const updated = {
        id: current.id,
        start_date: minStart,
        end_date: maxEnd,
        duration: newDuration,
      };

      if (current.parent_id) {
        await updateSummaryTaskDateRecursive(current.parent_id);
      }

      return updated;
    };

    // 5. 将T-002降级为T-001的子任务
    console.log('\n降级：T-002 → T-001的子任务');
    await client.query(`UPDATE tasks SET parent_id = $1, order_index = 0, updated_at = NOW() WHERE id = $2`, [task1Id, task2Id]);
    console.log('  调用 updateSummaryTaskDateRecursive(T-001)...');
    await updateSummaryTaskDateRecursive(task1Id);
    await showTasks('降级后');

    // 6. 将T-002升级
    console.log('\n升级：T-002 → 顶级任务');
    await client.query(`UPDATE tasks SET parent_id = NULL, order_index = 2, updated_at = NOW() WHERE id = $1`, [task2Id]);
    console.log('  调用 updateSummaryTaskDateRecursive(T-001)...');
    await updateSummaryTaskDateRecursive(task1Id);
    await showTasks('升级后');

    // 验证
    console.log('\n🔍 验证结果:');
    const final = await client.query('SELECT start_date, end_date FROM tasks WHERE id = $1', [task1Id]);
    const task1 = final.rows[0];
    const start = formatDate(task1.start_date);
    const end = formatDate(task1.end_date);

    console.log(`T-001最终日期: ${start} ~ ${end}`);
    console.log(`期望日期: 2026-03-20 ~ 2026-03-22`);

    if (start === '2026-03-20' && end === '2026-03-22') {
      console.log('✅ 测试成功！');
    } else {
      console.log('❌ 测试失败！');
    }

    await client.query('ROLLBACK');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ 出错:', err.message);
    console.error(err.stack);
  } finally {
    client.release();
    await pool.end();
  }
}

testIndentOutdentAPI();
