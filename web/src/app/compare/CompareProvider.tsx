import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../ui/Toast';
import { CompareTray } from './CompareTray';
import { CompareContext, type CompareStore } from './compareContext';
import {
  COMPARE_STORAGE_KEY,
  MAX_COMPARE,
  addCompareItem,
  compareKey,
  parseStoredList,
  type AddResult,
  type CompareItem,
  type CompareRef,
} from './compareList';
import '../i18n/register';

function readStored(): CompareItem[] {
  try {
    return parseStoredList(localStorage.getItem(COMPARE_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeStored(items: CompareItem[]) {
  try {
    localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // storage full / unavailable (private mode) — the list still works until the tab closes
  }
}

/**
 * The reader's compare list — pages (and versions of pages) set aside from any space, to be opened side by side.
 *
 * App-level, mounted once above the route tree (like AssistantHost): the sidebar row, the page header, the history
 * panel and the floating tray are all different subtrees reading and writing ONE list, and useLocalStorage does not
 * sync between hook instances. Persisted in localStorage (`folio:compare`) — it is this browser's scratchpad, not
 * something the server knows about; a storage event keeps other tabs of the same browser in step.
 */
export function CompareProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('app');
  const showToast = useToast();
  const [items, setItems] = useState<CompareItem[]>(readStored);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === COMPARE_STORAGE_KEY || event.key === null) setItems(readStored());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const update = useCallback((next: CompareItem[]) => {
    setItems(next);
    writeStored(next);
  }, []);

  const add = useCallback(
    (item: CompareItem): AddResult => {
      // Read the stored list, not only the state: another tab may have changed it since the last storage event.
      const { list, result } = addCompareItem(readStored(), item);
      if (result === 'added') {
        update(list);
        showToast(t('compare.added', { count: list.length, max: MAX_COMPARE }), 'info');
      } else if (result === 'duplicate') {
        showToast(t('compare.alreadyAdded'), 'info');
      } else {
        showToast(t('compare.full', { max: MAX_COMPARE }));
      }
      return result;
    },
    [showToast, t, update],
  );

  const remove = useCallback(
    (ref: CompareRef) => update(readStored().filter((entry) => compareKey(entry) !== compareKey(ref))),
    [update],
  );
  const clear = useCallback(() => update([]), [update]);
  const has = useCallback((ref: CompareRef) => items.some((entry) => compareKey(entry) === compareKey(ref)), [items]);

  const value = useMemo<CompareStore>(() => ({ items, add, remove, clear, has }), [items, add, remove, clear, has]);

  return (
    <CompareContext.Provider value={value}>
      {children}
      <CompareTray />
    </CompareContext.Provider>
  );
}
