/**
 * 测试任务降级后父任务日期自动更新功能
 * 直接操作数据库测试
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_app',
  user: 'postgres',
  password: '11111a',
});

async function testIndentParentUpdate() {
  const client = await pool.connect();
  let userId, projectId, task1Id, task2Id;

  try {
    await client.query('BEGIN');
    console.log('🧪 开始测试：任务降级后父任务日期自动更新\n');

    // 1. 获取或创建用户
    console.log('1️⃣ 获取测试用户...');
    const userRes = await client.query('SELECT id FROM users WHERE username = $1', ['admin']);
    if (userRes.rows.length === 0) {
      throw new Error('找不到admin用户');
    }
    userId = userRes.rows[0].id;
    console.log('✓ 用户ID:', userId);

    // 2. 创建项目
    console.log('\n2️⃣ 创建测试项目...');
    const projectRes = await client.query(
      `INSERT INTO projects (name, user_id, start_date, end_date)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      ['降级父任务更新测试', userId, '2026-03-20', '2026-03-28']
    );
    projectId = projectRes.rows[0].id;
    console.log('✓ 项目创建成功，ID:', projectId);

    // 3. 创建任务T-001
    console.log('\n3️⃣ 创建任务T-001 (2026-03-20 ~ 2026-03-22)');
    const task1Res = await client.query(
      `INSERT INTO tasks (project_id, name, start_date, end_date, duration, order_index)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [projectId, 'T-001', '2026-03-20', '2026-03-22', 2, 0]
    );
    task1Id = task1Res.rows[0].id;
    console.log('✓ T-001创建成功，ID:', task1Id);

    // 4. 创建任务T-002
    console.log('\n4️⃣ 创建任务T-002 (2026-03-25 ~ 2026-03-28)');
    const task2Res = await client.query(
      `INSERT INTO tasks (project_id, name, start_date, end_date, duration, order_index)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [projectId, 'T-002', '2026-03-25', '2026-03-28', 3, 1]
    );
    task2Id = task2Res.rows[0].id;
    console.log('✓ T-002创建成功，ID:', task2Id);

    // 5. 验证初始状态
    console.log('\n5️⃣ 验证初始状态:');
    const initialTasks = await client.query(
      'SELECT id, name, start_date, end_date, parent_id FROM tasks WHERE id IN ($1, $2)',
      [task1Id, task2Id]
    );
    initialTasks.rows.forEach(t => {
      console.log(`  ${t.name}: ${t.start_date} ~ ${t.end_date}, parent_id: ${t.parent_id || '无'}`);
    });

    // 6. 将T-002降级为T-001的子任务（模拟API操作）
    console.log('\n6️⃣ 将T-002降级为T-001的子任务...');

    // 更新T-002的parent_id
    await client.query(
      `UPDATE tasks
       SET parent_id = $1, order_index = 0, updated_at = NOW()
       WHERE id = $2`,
      [task1Id, task2Id]
    );
    console.log('✓ 降级操作完成');

    // 7. 手动调用updateSummaryTaskDateRecursive函数（模拟API中的逻辑）
    console.log('\n7️⃣ 调用updateSummaryTaskDateRecursive更新父任务...');

    // 获取当前摘要任务的信息（新逻辑：先获取父任务自己的日期）
    const currentRes = await client.query(
      'SELECT id, start_date, end_date, duration, parent_id FROM tasks WHERE id = $1',
      [task1Id]
    );

    const current = currentRes.rows[0];
    console.log(`  T-001当前时间: ${current.start_date} ~ ${current.end_date}`);

    // 获取所有子任务
    const childrenRes = await client.query(
      `SELECT id, start_date, end_date
       FROM tasks
       WHERE parent_id = $1 AND is_deleted = false
       ORDER BY start_date ASC`,
      [task1Id]
    );

    if (childrenRes.rows.length === 0) {
      console.log('❌ 错误：T-001应该有子任务，但查询结果为空');
      throw new Error('子任务查询失败');
    }

    console.log(`  找到 ${childrenRes.rows.length} 个子任务`);

    // 计算时间范围：包括摘要任务自己的日期和所有子任务的日期
    let minStart = current.start_date;
    let maxEnd = current.end_date;

    for (const child of childrenRes.rows) {
      const start = child.start_date;
      const end = child.end_date;
      console.log(`  子任务: ${start} ~ ${end}`);

      if (start && (!minStart || start < minStart)) minStart = start;
      if (end && (!maxEnd || end > maxEnd)) maxEnd = end;
    }

    console.log(`  计算得到的时间范围: ${minStart} ~ ${maxEnd}`);

    // 检查是否需要更新
    if (current.start_date === minStart && current.end_date === maxEnd) {
      console.log('  ⚠️  时间范围相同，不需要更新');
    } else {
      console.log('  📝 需要更新T-001的时间范围');

      // 计算新的工期
      const diffDays = (a, b) => {
        const da = new Date(a);
        const db = new Date(b);
        return Math.round((db.getTime() - da.getTime()) / 86400000);
      };
      const newDuration = diffDays(minStart, maxEnd);

      console.log(`  新工期: ${newDuration} 天`);

      // 更新摘要任务的时间
      await client.query(
        `UPDATE tasks
         SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW()
         WHERE id = $4`,
        [minStart, maxEnd, newDuration, task1Id]
      );
      console.log('  ✓ T-001时间已更新');
    }

    await client.query('COMMIT');

    // 8. 验证结果
    console.log('\n8️⃣ 验证结果:');
    const finalTasks = await client.query(
      'SELECT id, name, start_date, end_date, parent_id, duration FROM tasks WHERE id IN ($1, $2)',
      [task1Id, task2Id]
    );

    let testPassed = true;
    finalTasks.rows.forEach(t => {
      console.log(`  ${t.name}: ${t.start_date} ~ ${t.end_date}, parent_id: ${t.parent_id || '无'}, duration: ${t.duration}`);
    });

    const task1 = finalTasks.rows.find(t => t.id === task1Id);
    const task2 = finalTasks.rows.find(t => t.id === task2Id);

    // 验证T-002的parent_id是否正确
    if (task2.parent_id !== task1Id) {
      console.log('\n❌ 测试失败: T-002的parent_id不正确');
      testPassed = false;
    } else {
      console.log('\n✓ T-002的parent_id正确');
    }

    // 验证T-001的日期是否扩展到包含T-002
    const formatDate = (d) => {
      if (!d) return null;
      if (typeof d === 'string') return d.split('T')[0];
      // 处理Date对象，使用本地时区
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const task1Start = formatDate(task1.start_date);
    const task1End = formatDate(task1.end_date);

    if (task1Start !== '2026-03-20') {
      console.log(`❌ 测试失败: T-001的start_date应该是2026-03-20，实际是${task1Start}`);
      testPassed = false;
    } else if (task1End !== '2026-03-28') {
      console.log(`❌ 测试失败: T-001的end_date应该是2026-03-28，实际是${task1End}`);
      testPassed = false;
    } else {
      console.log('✅ 测试成功！T-001的日期已自动扩展为 2026-03-20 ~ 2026-03-28');
    }

    if (testPassed) {
      console.log('\n🎉 所有测试通过！');
    } else {
      console.log('\n💥 测试失败！');
    }

    // 清理测试数据
    console.log('\n🧹 清理测试数据...');
    await client.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
    await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
    console.log('✓ 清理完成');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ 测试出错:', err.message);
    console.error(err.stack);
  } finally {
    client.release();
    await pool.end();
  }
}

testIndentParentUpdate();
