import { useMemo } from 'react';
import { useLocalStorage } from '../hooks';
import { DEFAULT_GRAPH_SETTINGS, sanitizeSettings, type GraphSettings } from './graphModel';

/** localStorage key of a space's graph settings (filters, groups, display, forces, local depth). */
export const graphSettingsKey = (space: string): string => `folio:graph:${space}`;

/** The space's graph settings, remembered per space in this browser; a partial update merges. */
export function useGraphSettings(space: string): [GraphSettings, (patch: Partial<GraphSettings> | 'reset') => void] {
  const [raw, setRaw] = useLocalStorage<unknown>(graphSettingsKey(space), DEFAULT_GRAPH_SETTINGS);
  const settings = useMemo(() => sanitizeSettings(raw), [raw]);
  const update = (patch: Partial<GraphSettings> | 'reset') =>
    setRaw((prev: unknown) => (patch === 'reset' ? DEFAULT_GRAPH_SETTINGS : { ...sanitizeSettings(prev), ...patch }));
  return [settings, update];
}
