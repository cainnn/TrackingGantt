/**
 * 依赖管理功能测试脚本
 * 测试任务1延迟后，任务2是否自动往后排期
 */

// Node.js 18+ 内置 fetch，不需要 node-fetch
const BASE_URL = 'http://localhost:3001'; // 服务器运行在3001端口

// 日期格式化工具函数
function formatDate(isoDate) {
  if (!isoDate) return null;
  if (isoDate.includes('T')) {
    return isoDate.split('T')[0];
  }
  return isoDate;
}

// 测试数据
let testUser = {
  username: `test_user_${Date.now()}`,
  email: `test_user_${Date.now()}@test.com`,
  password: 'test123'
};

let authToken = null;
let testProject = null;
let task1 = null;
let task2 = null;
let dependency = null;

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function success(message) {
  log(`✓ ${message}`, 'green');
}

function error(message) {
  log(`✗ ${message}`, 'red');
}

function info(message) {
  log(`ℹ ${message}`, 'blue');
}

function section(message) {
  log(`\n${'='.repeat(60)}`, 'cyan');
  log(`${message}`, 'cyan');
  log('='.repeat(60), 'cyan');
}

async function registerUser() {
  section('1. 注册测试用户');
  try {
    const response = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testUser)
    });

    const data = await response.json();
    if (data.ok) {
      success(`用户注册成功: ${testUser.username}`);
      return true;
    } else {
      error(`用户注册失败: ${data.error || data.message}`);
      return false;
    }
  } catch (err) {
    error(`注册请求失败: ${err.message}`);
    return false;
  }
}

async function loginUser() {
  section('2. 登录获取Token');
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: testUser.username, // 使用 login 字段，可以是 username 或 email
        password: testUser.password
      })
    });

    const data = await response.json();
    if (data.ok && data.value.token) {
      authToken = data.value.token;
      success('登录成功，已获取认证Token');
      return true;
    } else {
      error(`登录失败: ${data.error || '未知错误'}`);
      return false;
    }
  } catch (err) {
    error(`登录请求失败: ${err.message}`);
    return false;
  }
}

async function createProject() {
  section('3. 创建测试项目');
  try {
    const response = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: '依赖管理测试项目',
        start_date: '2026-03-20'
      })
    });

    const data = await response.json();
    if (data.ok && data.value) {
      testProject = data.value;
      success(`项目创建成功: ${testProject.name} (ID: ${testProject.id})`);
      return true;
    } else {
      error(`项目创建失败: ${data.error || '未知错误'}`);
      return false;
    }
  } catch (err) {
    error(`项目创建请求失败: ${err.message}`);
    return false;
  }
}

async function createTasks() {
  section('4. 创建测试任务');
  try {
    // 创建任务1
    const response1 = await fetch(`${BASE_URL}/api/tasks/${testProject.id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify([
        {
          name: '任务1 - 前置任务',
          start_date: '2026-03-20',
          end_date: '2026-03-22',
          duration: 2,
          order_index: 0
        },
        {
          name: '任务2 - 后继任务',
          start_date: '2026-03-23',
          end_date: '2026-03-25',
          duration: 2,
          order_index: 1
        }
      ])
    });

    const data1 = await response1.json();
    if (data1.ok && data1.value && data1.value.length === 2) {
      task1 = data1.value.find(t => t.name.includes('任务1'));
      task2 = data1.value.find(t => t.name.includes('任务2'));
      success(`任务创建成功`);

      // 格式化日期显示
      const fmtDate = (isoDate) => isoDate ? isoDate.split('T')[0] : 'NULL';
      info(`  任务1: ${task1.name} (${fmtDate(task1.start_date)} ~ ${fmtDate(task1.end_date)})`);
      info(`  任务2: ${task2.name} (${fmtDate(task2.start_date)} ~ ${fmtDate(task2.end_date)})`);
      return true;
    } else {
      error(`任务创建失败: ${JSON.stringify(data1)}`);
      return false;
    }
  } catch (err) {
    error(`任务创建请求失败: ${err.message}`);
    return false;
  }
}

async function createDependency() {
  section('5. 创建依赖关系 (任务1 → 任务2)');
  try {
    const response = await fetch(`${BASE_URL}/api/dependencies/${testProject.id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        from_task_id: task1.id,
        to_task_id: task2.id,
        type: 2, // FS (Finish-to-Start)
        lag: 0
      })
    });

    const data = await response.json();
    if (data.ok && data.value) {
      dependency = data.value.dependency;
      success('依赖关系创建成功');

      // 检查是否有级联更新
      if (data.value.updatedTasks && data.value.updatedTasks.length > 0) {
        info('检测到级联更新:');
        data.value.updatedTasks.forEach(t => {
          info(`  ${t.name}: ${t.start_date} ~ ${t.end_date}`);
        });
      }
      return true;
    } else {
      error(`依赖关系创建失败: ${data.error || '未知错误'}`);
      return false;
    }
  } catch (err) {
    error(`依赖关系创建请求失败: ${err.message}`);
    return false;
  }
}

async function testCascadeUpdate() {
  section('6. 测试依赖级联更新 (核心测试)');
  info('场景：将任务1的结束日期从 2026-03-22 延迟到 2026-03-27');

  try {
    // 获取更新前的任务2状态
    const beforeResponse = await fetch(`${BASE_URL}/api/tasks/${testProject.id}?t=${Date.now()}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const beforeData = await beforeResponse.json();
    const task2Before = beforeData.value.tasks.find(t => t.id === task2.id);

    info(`更新前任务2: ${formatDate(task2Before.start_date)} ~ ${formatDate(task2Before.end_date)}`);

    // 更新任务1的日期（模拟拖拽延迟5天）
    const updateResponse = await fetch(`${BASE_URL}/api/tasks/${testProject.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify([
        {
          id: task1.id,
          start_date: '2026-03-25',
          end_date: '2026-03-27',
          duration: 2
        }
      ])
    });

    const updateData = await updateResponse.json();

    if (!updateData.ok) {
      error(`任务更新失败: ${updateData.error || '未知错误'}`);
      return false;
    }

    success('任务1更新成功');

    // 获取更新后的任务2状态
    const afterResponse = await fetch(`${BASE_URL}/api/tasks/${testProject.id}?t=${Date.now()}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const afterData = await afterResponse.json();
    const task2After = afterData.value.tasks.find(t => t.id === task2.id);

    info(`更新后任务2: ${formatDate(task2After.start_date)} ~ ${formatDate(task2After.end_date)}`);

    // 验证级联更新是否正确
    const expectedStartDate = '2026-03-28';
    const expectedEndDate = '2026-03-30';
    const actualStartDate = formatDate(task2After.start_date);
    const actualEndDate = formatDate(task2After.end_date);

    if (actualStartDate === expectedStartDate && actualEndDate === expectedEndDate) {
      success('✅ 测试通过！任务2正确地自动往后排期了');
      success(`   预期: ${expectedStartDate} ~ ${expectedEndDate}`);
      success(`   实际: ${actualStartDate} ~ ${actualEndDate}`);
      return true;
    } else {
      error('❌ 测试失败！任务2没有正确地自动往后排期');
      error(`   预期: ${expectedStartDate} ~ ${expectedEndDate}`);
      error(`   实际: ${actualStartDate} ~ ${actualEndDate}`);
      return false;
    }

  } catch (err) {
    error(`级联更新测试失败: ${err.message}`);
    return false;
  }
}

async function testScheduleEarlier() {
  section('7. 测试任务提前排期');
  info('场景：将任务1的结束日期提前到 2026-03-21');

  try {
    // 更新任务1的日期（提前1天）
    const updateResponse = await fetch(`${BASE_URL}/api/tasks/${testProject.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify([
        {
          id: task1.id,
          start_date: '2026-03-20',
          end_date: '2026-03-21',
          duration: 1
        }
      ])
    });

    const updateData = await updateResponse.json();

    if (!updateData.ok) {
      error(`任务更新失败: ${updateData.error || '未知错误'}`);
      return false;
    }

    success('任务1更新成功');

    // 获取更新后的任务2状态
    const afterResponse = await fetch(`${BASE_URL}/api/tasks/${testProject.id}?t=${Date.now()}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const afterData = await afterResponse.json();
    const task2After = afterData.value.tasks.find(t => t.id === task2.id);

    const actualStartDate = formatDate(task2After.start_date);
    const actualEndDate = formatDate(task2After.end_date);
    info(`任务2当前日期: ${actualStartDate} ~ ${actualEndDate}`);

    // 当任务1提前时，任务2应该调整到最早允许日期
    const expectedStartDate = '2026-03-22';
    const expectedEndDate = '2026-03-24';

    if (actualStartDate === expectedStartDate && actualEndDate === expectedEndDate) {
      success('✅ 测试通过！任务2正确地向前调整到最早允许日期');
      success(`   预期: ${expectedStartDate} ~ ${expectedEndDate}`);
      success(`   实际: ${actualStartDate} ~ ${actualEndDate}`);
      return true;
    } else {
      error('❌ 测试失败！任务2没有正确地向前调整');
      error(`   预期: ${expectedStartDate} ~ ${expectedEndDate}`);
      error(`   实际: ${actualStartDate} ~ ${actualEndDate}`);
      return false;
    }

  } catch (err) {
    error(`任务提前测试失败: ${err.message}`);
    return false;
  }
}

async function testAutoScheduleFlag() {
  section('8. 测试自动排程标志');
  info('场景：关闭任务2的自动排程，然后延迟任务1');

  try {
    // 关闭任务2的自动排程
    const toggleResponse = await fetch(`${BASE_URL}/api/tasks/${testProject.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify([
        {
          id: task2.id,
          auto_schedule: false
        }
      ])
    });

    const toggleData = await toggleResponse.json();
    if (!toggleData.ok) {
      error(`自动排程标志更新失败: ${toggleData.error || '未知错误'}`);
      return false;
    }

    success('任务2自动排程已关闭');

    // 延迟任务1
    const delayResponse = await fetch(`${BASE_URL}/api/tasks/${testProject.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify([
        {
          id: task1.id,
          start_date: '2026-03-25',
          end_date: '2026-03-27',
          duration: 2
        }
      ])
    });

    const delayData = await delayResponse.json();
    if (!delayData.ok) {
      error(`任务1更新失败: ${delayData.error || '未知错误'}`);
      return false;
    }

    success('任务1延迟成功');

    // 检查任务2是否保持不变
    const checkResponse = await fetch(`${BASE_URL}/api/tasks/${testProject.id}?t=${Date.now()}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const checkData = await checkResponse.json();
    const task2Check = checkData.value.tasks.find(t => t.id === task2.id);

    const actualStartDate = formatDate(task2Check.start_date);
    const actualEndDate = formatDate(task2Check.end_date);
    info(`任务2日期: ${actualStartDate} ~ ${actualEndDate}`);
    info(`任务2 auto_schedule: ${task2Check.auto_schedule}`);

    if (actualStartDate === '2026-03-22' && actualEndDate === '2026-03-24') {
      success('✅ 测试通过！关闭自动排程后，任务2保持不变');
      return true;
    } else {
      error('❌ 测试失败！任务2在不应该调整的时候被调整了');
      error(`   预期: 2026-03-22 ~ 2026-03-24`);
      error(`   实际: ${actualStartDate} ~ ${actualEndDate}`);
      return false;
    }

  } catch (err) {
    error(`自动排程标志测试失败: ${err.message}`);
    return false;
  }
}

async function runTests() {
  log('\n🚀 开始依赖管理功能测试\n', 'cyan');

  const results = [];

  // 按顺序执行测试
  results.push(await registerUser());
  if (!results[0]) {
    error('用户注册失败，无法继续测试');
    return;
  }

  results.push(await loginUser());
  if (!results[1]) {
    error('用户登录失败，无法继续测试');
    return;
  }

  results.push(await createProject());
  if (!results[2]) {
    error('项目创建失败，无法继续测试');
    return;
  }

  results.push(await createTasks());
  if (!results[3]) {
    error('任务创建失败，无法继续测试');
    return;
  }

  results.push(await createDependency());
  if (!results[4]) {
    error('依赖关系创建失败，无法继续测试');
    return;
  }

  results.push(await testCascadeUpdate());
  results.push(await testScheduleEarlier());
  results.push(await testAutoScheduleFlag());

  // 显示测试结果汇总
  section('测试结果汇总');
  const testNames = [
    '用户注册',
    '用户登录',
    '项目创建',
    '任务创建',
    '依赖关系创建',
    '级联更新测试 (延迟)',
    '任务提前测试',
    '自动排程标志测试'
  ];

  let passCount = 0;
  results.forEach((result, index) => {
    const status = result ? '✅ 通过' : '❌ 失败';
    const color = result ? 'green' : 'red';
    log(`${testNames[index]}: ${status}`, color);
    if (result) passCount++;
  });

  log('\n' + '='.repeat(60), 'cyan');
  log(`总计: ${passCount}/${results.length} 测试通过`, passCount === results.length ? 'green' : 'yellow');
  log('='.repeat(60) + '\n', 'cyan');

  if (passCount === results.length) {
    success('🎉 所有测试通过！依赖管理功能正常工作');
    log('\n💡 你可以在浏览器中访问 http://localhost:3000 手动测试', 'blue');
  } else {
    error('⚠️  部分测试失败，请检查日志');
  }
}

// 运行测试
runTests().catch(err => {
  error(`测试运行出错: ${err.message}`);
  console.error(err);
});
