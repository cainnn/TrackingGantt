#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# migrate-vps.sh
# 对 VPS 远程 PostgreSQL 执行幂等 ALTER（新增列等迁移）
#
# 用法:
#   ./scripts/migrate-vps.sh <VPS_HOST>
#   VPS_HOST=1.2.3.4 ./scripts/migrate-vps.sh
# ============================================================

VPS_HOST="${1:-${VPS_HOST:-}}"
VPS_PORT="${VPS_PORT:-5432}"
VPS_DB="${VPS_DB:-gantt_app}"
VPS_USER="${VPS_USER:-postgres}"
VPS_PASSWORD="${VPS_PASSWORD:-11111a}"

if [[ -z "$VPS_HOST" ]]; then
  echo "错误: 请提供 VPS 地址"
  echo "用法: $0 <VPS_HOST>"
  exit 1
fi

echo "对 ${VPS_USER}@${VPS_HOST}:${VPS_PORT}/${VPS_DB} 执行迁移..."

PGPASSWORD="$VPS_PASSWORD" psql \
  -h "$VPS_HOST" -p "$VPS_PORT" -U "$VPS_USER" -d "$VPS_DB" \
  -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE tasks            ADD COLUMN IF NOT EXISTS rollup              BOOLEAN     DEFAULT false;
ALTER TABLE tasks            ADD COLUMN IF NOT EXISTS inactive            BOOLEAN     DEFAULT false;
ALTER TABLE tasks            ADD COLUMN IF NOT EXISTS project_boundary    VARCHAR(20) DEFAULT 'ask';
ALTER TABLE tasks            ADD COLUMN IF NOT EXISTS baseline_end_date   DATE;
ALTER TABLE tasks            ADD COLUMN IF NOT EXISTS deadline            DATE;
ALTER TABLE tasks            ADD COLUMN IF NOT EXISTS status              VARCHAR(40);
ALTER TABLE tasks            ADD COLUMN IF NOT EXISTS original_start_date DATE;
ALTER TABLE tasks            ADD COLUMN IF NOT EXISTS original_end_date   DATE;
ALTER TABLE dependencies     ADD COLUMN IF NOT EXISTS active              BOOLEAN     DEFAULT true;
ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS is_autosave         BOOLEAN     DEFAULT false;

CREATE TABLE IF NOT EXISTS task_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status_date_at_change DATE,
  field VARCHAR(40) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  changed_by UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tcl_project  ON task_change_log(project_id);
CREATE INDEX IF NOT EXISTS idx_tcl_task     ON task_change_log(task_id);
CREATE INDEX IF NOT EXISTS idx_tcl_statusdt ON task_change_log(status_date_at_change);
SQL

echo "完成。"
