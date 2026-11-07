import type { PoolClient } from 'pg'
import { planSubmittedHierarchy, type HierarchyTask } from '../submittedTaskHierarchy'
import { addLifecycleBatch } from '../taskLifecycle'

export async function persistSubmittedHierarchy(
  client: PoolClient, projectId: string, userId: string,
  existing: HierarchyTask[], plan: ReturnType<typeof planSubmittedHierarchy>,
) {
  await client.query(`UPDATE tasks t
    SET parent_id = p.parent_id, is_deleted = false, deleted_at = NULL,
        updated_at = CASE WHEN t.is_deleted OR t.parent_id IS DISTINCT FROM p.parent_id THEN NOW() ELSE t.updated_at END
    FROM jsonb_to_recordset($2::jsonb) AS p(id uuid, parent_id uuid)
    WHERE t.id = p.id AND t.project_id = $1
      AND (t.is_deleted OR t.parent_id IS DISTINCT FROM p.parent_id)`, [projectId, JSON.stringify(plan.parents)])
  const old = new Map(existing.map(t => [t.id, t]))
  await addLifecycleBatch(client, [
    ...plan.restoreIds.map(id => ({ taskId: id, taskCode: old.get(id)?.task_code ?? id, projectId, userId,
      event_type: 'updated', field_name: 'is_deleted', old_value: 'true', new_value: 'false',
      description: `按用户本次提交恢复任务「${old.get(id)?.name ?? id}」`,
    })),
    ...plan.repairs.map(repair => ({ taskId: repair.taskId, taskCode: old.get(repair.taskId)?.task_code ?? repair.taskId,
      projectId, userId, event_type: 'updated', field_name: 'parent_id',
      old_value: repair.requestedParent, new_value: repair.parentId,
      description: `任务「${repair.taskName}」：${repair.message}`,
    })),
  ])
  if (plan.repairs.length) console.warn('Repaired submitted task hierarchy', { projectId, repairs: plan.repairs })
}
