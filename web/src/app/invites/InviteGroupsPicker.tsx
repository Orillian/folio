import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useAuthOptional } from '../auth/AuthProvider';
import '../i18n/register';

export interface InviteGroupsPickerProps {
  value: string[];
  onChange: (groupIds: string[]) => void;
}

/**
 * Groups (053) the invited person joins on accepting. An instance admin may pick any active group, anyone
 * else only the groups they manage (GroupInfo.canManage). Renders nothing while there is nothing to pick
 * (older server, 403, no groups) so the invite form is unchanged in that case.
 */
export function InviteGroupsPicker({ value, onChange }: InviteGroupsPickerProps) {
  const { t } = useTranslation('app');
  const user = useAuthOptional()?.user;
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.listGroups, retry: false });
  const options = (groups.data?.groups ?? []).filter((g) => g.archivedAt === null && (user?.isAdmin || g.canManage));
  if (options.length === 0) return null;

  function toggle(id: string, checked: boolean) {
    onChange(checked ? [...value, id] : value.filter((v) => v !== id));
  }

  return (
    <fieldset className="flex flex-col gap-1.5 rounded-md border border-neutral-200 p-2.5 dark:border-neutral-800">
      <legend className="px-1 text-xs text-neutral-500 dark:text-neutral-400">{t('invites.groups')}</legend>
      <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
        {options.map((g) => (
          <label key={g.id} className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input type="checkbox" checked={value.includes(g.id)} onChange={(e) => toggle(g.id, e.target.checked)} />
            <span className="min-w-0 flex-1 truncate">{g.name}</span>
            <span className="shrink-0 text-xs text-neutral-400">{g.memberCount}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
