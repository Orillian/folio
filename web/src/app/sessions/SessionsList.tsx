import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { SessionInfo } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { formatDateTime } from '../formatDate';
import { formatRelativeDate } from '../history';
import { describeUserAgent } from '../admin/audit/logic';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import '../i18n/register';

export interface SessionsListProps {
  /** Omit for the signed-in person's own sessions ("Sign out other devices"); set by an instance admin to manage another person's. */
  userId?: string;
}

const LINK_BUTTON = 'shrink-0 rounded px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40';

/**
 * Signed-in browser sessions: device, address, last activity, with a revoke per row and a bulk
 * action — "Sign out other devices" for yourself, "Sign out everywhere" for an admin looking at
 * somebody else. Ending a session also closes the tabs' live connections on the server.
 */
export function SessionsList({ userId }: SessionsListProps) {
  const { t, i18n } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const key = ['sessions', userId ?? 'me'] as const;
  const [confirmAll, setConfirmAll] = useState(false);

  const list = useQuery({ queryKey: key, queryFn: () => (userId ? api.listUserSessions(userId) : api.listMySessions()), retry: false });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });

  const revokeOne = useMutation({
    mutationFn: (id: string) => (userId ? api.revokeUserSession(userId, id) : api.revokeMySession(id)),
    onSuccess: refresh,
    onError: (err) => showToast(errorText(err, 'sessions.revokeFailed')),
  });
  const revokeMany = useMutation({
    mutationFn: () => (userId ? api.revokeAllUserSessions(userId) : api.revokeOtherSessions()),
    onSuccess: (res) => {
      setConfirmAll(false);
      showToast(t('sessions.revokedCount', { count: res.revoked }));
      refresh();
    },
    onError: (err) => {
      setConfirmAll(false);
      showToast(errorText(err, 'sessions.revokeFailed'));
    },
  });

  const sessions = list.data?.sessions ?? [];
  const others = userId ? sessions.length : sessions.filter((s) => !s.current).length;

  return (
    <div className="flex flex-col gap-2">
      {list.isPending && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
      {list.isError && <p className="text-sm text-neutral-400">{t('sessions.loadFailed')}</p>}
      {list.isSuccess && sessions.length === 0 && <p className="text-sm text-neutral-400">{t('sessions.empty')}</p>}
      {sessions.length > 0 && (
        <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} locale={i18n.language} onRevoke={() => revokeOne.mutate(s.id)} busy={revokeOne.isPending} />
          ))}
        </ul>
      )}
      {others > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setConfirmAll(true)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {userId ? t('sessions.signOutEverywhere') : t('sessions.signOutOthers')}
          </button>
        </div>
      )}
      {confirmAll && (
        <ConfirmDialog
          title={userId ? t('sessions.signOutEverywhere') : t('sessions.signOutOthers')}
          confirmLabel={userId ? t('sessions.signOutEverywhere') : t('sessions.signOutOthers')}
          destructive
          busy={revokeMany.isPending}
          onConfirm={() => revokeMany.mutate()}
          onCancel={() => setConfirmAll(false)}
        >
          <p className="text-sm text-neutral-600 dark:text-neutral-300">{userId ? t('sessions.confirmEverywhere') : t('sessions.confirmOthers')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function SessionRow({ session, locale, onRevoke, busy }: { session: SessionInfo; locale: string; onRevoke: () => void; busy: boolean }) {
  const { t } = useTranslation('app');
  const device = describeUserAgent(session.userAgent) ?? t('sessions.unknownDevice');
  const lastSeen = session.lastSeenAt ?? session.createdAt;
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-neutral-800 dark:text-neutral-200">
          <span title={session.userAgent ?? undefined} className="truncate font-medium">
            {device}
          </span>
          {session.current && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-950 dark:text-green-300">{t('sessions.thisDevice')}</span>
          )}
        </div>
        <div className="truncate text-xs text-neutral-500 dark:text-neutral-400" title={t('sessions.signedInAt', { when: formatDateTime(session.createdAt, locale) })}>
          {[session.ip, t('sessions.lastActive', { when: formatRelativeDate(lastSeen) })].filter(Boolean).join(' · ')}
        </div>
      </div>
      {/* This device is left with the account menu's "Log out": ending it from here would pull the page out from under the person. */}
      {!session.current && (
        <button type="button" disabled={busy} onClick={onRevoke} className={LINK_BUTTON}>
          {t('sessions.revoke')}
        </button>
      )}
    </li>
  );
}
