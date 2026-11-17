import type { SaveBaseline } from './clientSave'
import { findPlanSaveMismatches } from './planSaveVerification'
import { hasDraftChanges, type DraftRootState, type DraftSnapshot } from '../store/draftHistory'

// A response started before our own save/reconciliation must never replace it.
export function decidePlanSync(state: DraftRootState, projectId: string, source: DraftSnapshot | null, remote: SaveBaseline, interacting: boolean) {
  if (!source || state.draft.baseline !== source || state.draft.projectId !== projectId || state.project.currentProject?.id !== projectId) return 'stale'
  if (!findPlanSaveMismatches(source, remote).length) return 'current'
  if (interacting || state.draft.saving || state.draft.uncertain || state.tasks.viewSnapshot || state.draft.future.length || hasDraftChanges(state)) return 'defer'
  return 'apply'
}
