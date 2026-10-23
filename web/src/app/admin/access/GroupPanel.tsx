import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, UserPlus } from 'lucide-react';
import type { AccessMatrixUser, GroupDetail } from '@shared/contracts';
import { api } from '../../api';
import { useApiErrorText } from '../../errorText';
import { roleLabel } from '../../auth/roles';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { addCandidates, matchesMemberQuery } from './groupsLogic';
import '../../i18n/register';

export interface GroupPanelProps {
  groupId: string;
  /** Every instance user (the access matrix's list) — the pool the "add members" search draws from. */
  users: AccessMatrixUser[];
  onDeleted: () => void;
}

/** One group's detail: rename / description / archive / delete, its members (search, manager toggle, remove, add) and the spaces it holds a role in. */
export function GroupPanel({ groupId, users, onDeleted }: GroupPanelProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [memberQuery, setMemberQuery] = useState('');
  const [addQuery, setAddQuery] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const detail = useQuery({ queryKey: ['groups', groupId], queryFn: () => api.getGroup(groupId) });
  const group = detail.data;

  useEffect(() => {
    if (!group) return;
    setName(group.name);
    setDescription(group.description);
  }, [group?.name, group?.description]); // eslint-disable-line react-hooks/exhaustive-deps

  function refresh(next?: GroupDetail) {
    if (next) queryClient.setQueryData(['groups', groupId], next);
    queryClient.invalidateQueries({ queryKey: ['groups'] });
    queryClient.invalidateQueries({ queryKey: ['access'] });
    queryClient.invalidateQueries({ queryKey: ['members'] });
  }
  const onError = (err: unknown) => showToast(errorText(err, 'access.groups.changeFailed'));

  const update = useMutation({
    mutationFn: (body: { name?: string; description?: string; archived?: boolean }) => api.updateGroup(groupId, body),
    onSuccess: () => refresh(),
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteGroup(groupId),
    onSuccess: () => {
      setConfirmDelete(false);
      queryClient.removeQueries({ queryKey: ['groups', groupId] });
      refresh();
      onDeleted();
    },
    onError: (err) => {
      setConfirmDelete(false);
      onError(err);
    },
  });
  const addMembers = useMutation({
    mutationFn: (userId: string) => api.addGroupMembers(groupId, [userId]),
    onSuccess: (next) => {
      setAddQuery('');
      refresh(next);
    },
    onError,
  });
  const setManager = useMutation({
    mutationFn: (vars: { userId: string; isManager: boolean }) => api.setGroupManager(groupId, vars.userId, vars.isManager),
    onSuccess: (next) => refresh(next),
    onError,
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.removeGroupMember(groupId, userId),
    onSuccess: (next) => refresh(next),
    onError,
  });

  const busy = update.isPending || addMembers.isPending || setManager.isPending || removeMember.isPending;
  const archived = group?.archivedAt != null;
  const dirty = group !== undefined && (name.trim() !== group.name || description.trim() !== group.description);
  const members = (group?.members ?? []).filter((m) => matchesMemberQuery(m, memberQuery));
  const fromIdp = (source: string) => source === 'oidc' || source === 'saml';
  const hasIdpMembers = (group?.members ?? []).some((m) => fromIdp(m.source));
  const candidates = addCandidates(users, group?.members ?? [], addQuery);

  return (
    <div className="flex flex-col gap-4 border-t border-neutral-100 bg-neutral-50/60 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-900/40">
      {detail.isLoading && <p className="text-xs text-neutral-400">{t('ui.loading')}</p>}
      {detail.isError && <p className="text-xs text-red-600 dark:text-red-400">{t('access.groups.loadFailed')}</p>}

      {group && (
        <>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty && name.trim()) update.mutate({ name: name.trim(), description: description.trim() });
            }}
          >
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                {t('access.groups.nameLabel')}
                <input
                  value={name}
                  maxLength={120}
                  onChange={(e) => setName(e.target.value)}
                  className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm text-neutral-800 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-200"
                />
              </label>
              <label className="flex min-w-[12rem] flex-[2] flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                {t('access.groups.descriptionLabel')}
                <input
                  value={description}
                  maxLength={1000}
                  onChange={(e) => setDescription(e.target.value)}
                  className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm text-neutral-800 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-200"
                />
              </label>
              <button
                type="submit"
                disabled={!dirty || !name.trim() || busy}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
              >
                {t('access.groups.save')}
              </button>
            </div>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => update.mutate({ archived: !archived })}
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {archived ? t('access.groups.unarchive') : t('access.groups.archive')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
            >
              <Trash2 size={12} /> {t('ui.delete')}
            </button>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">{archived ? t('access.groups.archivedHint') : t('access.groups.archiveHint')}</span>
          </div>
          {(fromIdp(group.source) || hasIdpMembers) && (
            <p className="text-xs text-blue-700 dark:text-blue-300">{fromIdp(group.source) ? t('access.groups.idpGroupHint') : t('access.groups.idpReadOnly')}</p>
          )}

          <section>
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {t('access.groups.members')} · {group.memberCount}
              </p>
              {group.members.length > 6 && (
                <input
                  value={memberQuery}
                  onChange={(e) => setMemberQuery(e.target.value)}
                  placeholder={t('access.groups.searchMembers')}
                  aria-label={t('access.groups.searchMembers')}
                  className="ml-auto min-w-0 rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-200"
                />
              )}
            </div>
            {group.members.length === 0 ? (
              <p className="text-xs text-neutral-400">{t('access.groups.noMembers')}</p>
            ) : (
              <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                {members.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-neutral-800 dark:text-neutral-200">
                        {m.name}
                        {fromIdp(m.source) && (
                          <span
                            data-testid="member-source-badge"
                            title={t('access.groups.memberFromIdp', { source: t(`access.groups.source.${m.source}`, { defaultValue: m.source }) })}
                            className="ml-1.5 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                          >
                            {t(`access.groups.source.${m.source}`, { defaultValue: m.source })}
                          </span>
                        )}
                        {m.disabled && <span className="ml-1.5 text-xs text-neutral-400">{t('access.people.disabled')}</span>}
                      </div>
                      <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">{m.email}</div>
                    </div>
                    <label className="flex shrink-0 items-center gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                      <input
                        type="checkbox"
                        checked={m.isManager}
                        disabled={busy}
                        onChange={(e) => setManager.mutate({ userId: m.userId, isManager: e.target.checked })}
                        aria-label={t('access.groups.managerNamed', { name: m.name })}
                      />
                      {t('access.groups.manager')}
                    </label>
                    <button
                      type="button"
                      disabled={busy || fromIdp(m.source)}
                      aria-label={t('access.groups.removeNamed', { name: m.name })}
                      title={fromIdp(m.source) ? t('access.groups.idpReadOnly') : t('access.groups.removeNamed', { name: m.name })}
                      onClick={() => removeMember.mutate(m.userId)}
                      className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-neutral-800"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-2 border-t border-neutral-200 pt-2 dark:border-neutral-800">
              <label className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                <UserPlus size={13} className="shrink-0" />
                <input
                  value={addQuery}
                  onChange={(e) => setAddQuery(e.target.value)}
                  placeholder={t('access.groups.addPlaceholder')}
                  aria-label={t('access.groups.addPlaceholder')}
                  className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm text-neutral-800 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-200"
                />
              </label>
              {addQuery.trim() && candidates.length === 0 && <p className="mt-1.5 text-xs text-neutral-400">{t('access.groups.noCandidates')}</p>}
              {candidates.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {candidates.map((u) => (
                    <li key={u.id} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 truncate text-sm text-neutral-800 dark:text-neutral-200">
                        {u.name} <span className="text-xs text-neutral-500 dark:text-neutral-400">{u.email}</span>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => addMembers.mutate(u.id)}
                        className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      >
                        <Plus size={12} /> {t('members.add')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section>
            <p className="mb-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('access.groups.spaces')}</p>
            {group.spaces.length === 0 ? (
              <p className="text-xs text-neutral-400">{t('access.groups.noSpaces')}</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {group.spaces.map((s) => (
                  <span key={s.space} className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                    {s.spaceName}: {roleLabel(s.role)}
                  </span>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {confirmDelete && group && (
        <ConfirmDialog
          title={t('access.groups.deleteTitle', { name: group.name })}
          destructive
          confirmLabel={t('ui.delete')}
          busy={remove.isPending}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => remove.mutate()}
        >
          <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('access.groups.deleteBody')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
