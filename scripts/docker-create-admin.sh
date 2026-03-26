#!/bin/bash

# 在 Docker 容器中创建管理员用户的脚本

set -e

echo "创建管理员用户..."

# 读取用户输入
read -p "用户名: " USERNAME
read -sp "密码: " PASSWORD
echo ""
read -p "邮箱: " EMAIL

# 在 app 容器中执行创建用户的命令
docker-compose exec -T app node -e "
const bcrypt = require('bcryptjs');
const { pool } = require('./lib/db.ts');

async function createUser() {
  const hashedPassword = await bcrypt.hash('$PASSWORD', 10);
  const result = await pool.query(
    'INSERT INTO users (username, password, email) VALUES (\$1, \$2, \$3) RETURNING id',
    ['$USERNAME', hashedPassword, '$EMAIL']
  );
  console.log('用户创建成功，ID:', result.rows[0].id);
  process.exit(0);
}

createUser().catch(err => {
  console.error('创建失败:', err.message);
  process.exit(1);
});
"

echo "✓ 管理员用户创建完成"
