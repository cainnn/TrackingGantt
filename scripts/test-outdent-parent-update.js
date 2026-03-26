/**
 * 测试任务降级后再升级后父任务日期自动收缩功能
 * 场景：
 * 1. 创建任务T-001 (2026-03-20 ~ 2026-03-22)
 * 2. 创建任务T-002 (2026-03-25 ~ 2026-03-28)
 * 3. 将T-002降级为T-001的子任务 → T-001应变为 2026-03-20 ~ 2026-03-28
 * 4. 将T-002升级（移出T-001） → T-001应恢复为 2026-03-20 ~ 2026-03-22
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function testOutdentParentUpdate() {
  const client = await pool.connect();
  let userId, projectId, task1Id, task2Id;

  try {
    await client.query('BEGIN');
    console.log('🧪 开始测试：任务升级后父任务日期自动收缩\n');

    // 1. 获取测试用户
    console.log('1️⃣ 获取测试用户...');
    const userRes = await client.query('SELECT id FROM users WHERE username = $1', ['admin']);
    userId = userRes.rows[0].id;
    console.log('✓ 用户ID:', userId);

    // 2. 创建项目
    console.log('\n2️⃣ 创建测试项目...');
    const projectRes = await client.query(
      `INSERT INTO projects (name, user_id, start_date, end_date)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      ['升级父任务更新测试', userId, '2026-03-20', '2026-03-28']
    );
    projectId = projectRes.rows[0].id;
    console.log('✓ 项目创建成功');

    // 3. 创建任务T-001 (2026-03-20 ~ 2026-03-22)
    console.log('\n3️⃣ 创建任务T-001 (2026-03-20 ~ 2026-03-22)');
    const task1Res = await client.query(
      `INSERT INTO tasks (project_id, name, start_date, end_date, duration, order_index)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [projectId, 'T-001', '2026-03-20', '2026-03-22', 2, 0]
    );
    task1Id = task1Res.rows[0].id;

    // 4. 创建任务T-002 (2026-03-25 ~ 2026-03-28)
    console.log('4️⃣ 创建任务T-002 (2026-03-25 ~ 2026-03-28)');
    const task2Res = await client.query(
      `INSERT INTO tasks (project_id, name, start_date, end_date, duration, order_index)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
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
      console.log(`\n${msg}:`);
      const tasks = await client.query(
        'SELECT id, name, start_date, end_date, parent_id FROM tasks WHERE id IN ($1, $2)',
        [task1Id, task2Id]
      );
      tasks.rows.forEach(t => {
        console.log(`  ${t.name}: ${formatDate(t.start_date)} ~ ${formatDate(t.end_date)}, parent: ${t.parent_id ? 'T-001' : '无'}`);
      });
    };

    await showTasks('5️⃣ 初始状态');

    // 6. 将T-002降级为T-001的子任务
    console.log('\n6️⃣ 将T-002降级为T-001的子任务...');
    await client.query(
      `UPDATE tasks SET parent_id = $1, order_index = 0, updated_at = NOW() WHERE id = $2`,
      [task1Id, task2Id]
    );

    // 更新T-001的时间范围
    const childrenRes = await client.query(
      `SELECT id, start_date, end_date FROM tasks WHERE parent_id = $1 AND is_deleted = false`,
      [task1Id]
    );

    if (childrenRes.rows.length > 0) {
      const currentRes = await client.query(
        'SELECT id, start_date, end_date FROM tasks WHERE id = $1',
        [task1Id]
      );
      const current = currentRes.rows[0];

      let minStart = current.start_date;
      let maxEnd = current.end_date;

      for (const child of childrenRes.rows) {
        if (child.start_date < minStart) minStart = child.start_date;
        if (child.end_date > maxEnd) maxEnd = child.end_date;
      }

      const newDuration = Math.round((new Date(maxEnd) - new Date(minStart)) / 86400000);
      await client.query(
        `UPDATE tasks SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW() WHERE id = $4`,
        [minStart, maxEnd, newDuration, task1Id]
      );
    }

    await showTasks('7️⃣ 降级后');

    // 8. 将T-002升级（移出T-001）
    console.log('\n8️⃣ 将T-002升级（parent_id设为null）...');
    await client.query(
      `UPDATE tasks SET parent_id = NULL, order_index = 2, updated_at = NOW() WHERE id = $1`,
      [task2Id]
    );

    // 更新T-001的时间范围（应该收缩回原来的日期）
    const childrenRes2 = await client.query(
      `SELECT id, start_date, end_date FROM tasks WHERE parent_id = $1 AND is_deleted = false`,
      [task1Id]
    );

    console.log(`  查询T-001的子任务数量: ${childrenRes2.rows.length}`);

    if (childrenRes2.rows.length === 0) {
      console.log('  ⚠️  T-001没有子任务了，不需要更新为摘要任务的日期');
      console.log('  ℹ️  T-001保持自己的工作日期: 2026-03-20 ~ 2026-03-28');
      console.log('  ❌ 但是应该是: 2026-03-20 ~ 2026-03-22');
    } else {
      const currentRes = await client.query(
        'SELECT id, start_date, end_date FROM tasks WHERE id = $1',
        [task1Id]
      );
      const current = currentRes.rows[0];

      let minStart = current.start_date;
      let maxEnd = current.end_date;

      for (const child of childrenRes2.rows) {
        if (child.start_date < minStart) minStart = child.start_date;
        if (child.end_date > maxEnd) maxEnd = child.end_date;
      }

      const newDuration = Math.round((new Date(maxEnd) - new Date(minStart)) / 86400000);
      await client.query(
        `UPDATE tasks SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW() WHERE id = $4`,
        [minStart, maxEnd, newDuration, task1Id]
      );
    }

    await showTasks('9️⃣ 升级后');

    // 验证结果
    console.log('\n🔍 验证结果:');
    const finalTasks = await client.query(
      'SELECT id, name, start_date, end_date, parent_id FROM tasks WHERE id IN ($1, $2)',
      [task1Id, task2Id]
    );

    const task1 = finalTasks.rows.find(t => t.id === task1Id);
    const task2 = finalTasks.rows.find(t => t.id === task2Id);
    const task1Start = formatDate(task1.start_date);
    const task1End = formatDate(task1.end_date);

    console.log(`T-001最终日期: ${task1Start} ~ ${task1End}`);
    console.log(`期望日期: 2026-03-20 ~ 2026-03-22`);

    if (task1Start === '2026-03-20' && task1End === '2026-03-22') {
      console.log('✅ 测试成功！');
    } else {
      console.log('❌ 测试失败！');
      console.log(`问题：T-001失去子任务后，应该恢复为摘要任务之前的日期（自己的工作日期）`);
    }

    await client.query('ROLLBACK');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ 测试出错:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

testOutdentParentUpdate();
