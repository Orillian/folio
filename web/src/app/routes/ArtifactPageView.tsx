import { useState } from 'react';
import type { PageDoc } from '@shared/contracts';
import { ArtifactView } from '../../artifact/ArtifactView';
import { ArtifactImportDialog } from '../../artifact/ArtifactImportDialog';
import { api } from '../api';

export interface ArtifactPageViewProps {
  page: PageDoc;
  /** Editor+ on the space and a page the server already has: may replace the bundle. */
  canReplace: boolean;
}

/**
 * An artifact page in the app (session): the sandboxed page plus Download for every reader and "Replace…" for
 * editors, which reopens the import dialog on this page. The frame reloads when the bundle was replaced.
 */
export function ArtifactPageView({ page, canReplace }: ArtifactPageViewProps) {
  const [replacing, setReplacing] = useState(false);
  const [replaced, setReplaced] = useState(0);
  if (!page.artifact) return null;
  return (
    <>
      <ArtifactView
        payload={page.artifact}
        pageId={page.id}
        title={page.title}
        version={`${page.updatedAt}:${replaced}`}
        downloadUrl={api.artifactDownloadUrl(page.id)}
        onReplace={canReplace ? () => setReplacing(true) : undefined}
      />
      {replacing && (
        <ArtifactImportDialog
          space={page.space}
          replacePageId={page.id}
          onReplaced={() => setReplaced((n) => n + 1)}
          onClose={() => setReplacing(false)}
        />
      )}
    </>
  );
}
