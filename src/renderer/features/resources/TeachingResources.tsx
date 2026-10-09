import type { ReactNode } from 'react';
import { workspaceAreas, type AppView } from '../../WorkspaceNavigation';
import type { Snapshot } from '../../../shared/contracts';
import { ResourceLibraryPage } from './ResourceLibraryPage';
export function TeachingResources({
  snapshot,
  view,
  onNavigate,
  onDirtyChange,
  children,
}: {
  snapshot: Snapshot;
  view: AppView;
  onNavigate: (view: AppView) => boolean;
  onDirtyChange: (dirty: boolean) => void;
  children: ReactNode;
}) {
  return (
    <section aria-label="教师备课工作区">
      <nav className="workspace-tabs" aria-label="教师备课功能">
        {workspaceAreas[0]!.entries.map((e) => (
          <button
            key={e.view}
            className={
              (view === 'teaching' && e.view === 'resourceLibrary') || view === e.view
                ? 'selected'
                : ''
            }
            aria-current={
              (view === 'teaching' && e.view === 'resourceLibrary') || view === e.view
                ? 'page'
                : undefined
            }
            onClick={() => onNavigate(e.view)}
          >
            {e.label}
          </button>
        ))}
      </nav>
      {['teaching', 'resourceLibrary'].includes(view) ? (
        <ResourceLibraryPage epoch={snapshot.epoch} onDirtyChange={onDirtyChange} />
      ) : (
        children
      )}
    </section>
  );
}
