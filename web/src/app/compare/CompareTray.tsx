import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Columns2, X } from 'lucide-react';
import { useOutsideClick } from '../hooks';
import { shortSha } from '../history';
import { useCompare } from './compareContext';
import { comparePath } from './compareList';
import '../i18n/register';

/**
 * The floating chip with the compare list: "Compare · N", and a popover over it with the items, "Open" (from two
 * items) and "Clear". Bottom centre of the window — clear of the sidebar, the assistant panel (right) and the toasts
 * (bottom right). Hidden on the compare page itself, which shows its own bar.
 */
export function CompareTray() {
  const { t } = useTranslation('app');
  const { items, remove, clear } = useCompare();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useOutsideClick([rootRef], () => setOpen(false));

  if (items.length === 0 || location.pathname === '/compare') return null;

  return (
    <div ref={rootRef} data-report-exclude="" className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2">
      {open && (
        <div
          role="dialog"
          aria-label={t('compare.title')}
          className="absolute bottom-full left-1/2 mb-2 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {items.map((item) => (
              <li key={item.sha ? `${item.pageId}@${item.sha}` : item.pageId} className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-800">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-neutral-800 dark:text-neutral-100">{item.title}</div>
                  <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {item.space}
                    {item.sha ? ` · ${t('compare.tray.version', { sha: shortSha(item.sha) })}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={t('compare.remove')}
                  title={t('compare.remove')}
                  onClick={() => remove(item)}
                  className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-neutral-200 pt-2 dark:border-neutral-700">
            <button
              type="button"
              onClick={() => {
                clear();
                setOpen(false);
              }}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {t('compare.clear')}
            </button>
            <button
              type="button"
              disabled={items.length < 2}
              title={items.length < 2 ? t('compare.tray.needTwo') : undefined}
              onClick={() => {
                setOpen(false);
                navigate(comparePath(items));
              }}
              className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {t('compare.tray.open')}
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-3.5 py-2 text-sm font-medium text-neutral-800 shadow-lg hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
      >
        <Columns2 size={15} aria-hidden="true" />
        {t('compare.tray.label', { count: items.length })}
      </button>
    </div>
  );
}
