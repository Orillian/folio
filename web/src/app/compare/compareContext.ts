import { createContext, useContext } from 'react';
import type { AddResult, CompareItem, CompareRef } from './compareList';

export interface CompareStore {
  items: CompareItem[];
  /** Adds an item and tells the reader what happened (a toast); returns the outcome. */
  add: (item: CompareItem) => AddResult;
  remove: (ref: CompareRef) => void;
  clear: () => void;
  has: (ref: CompareRef) => boolean;
}

const NOOP_STORE: CompareStore = { items: [], add: () => 'full', remove: () => {}, clear: () => {}, has: () => false };
export const CompareContext = createContext<CompareStore>(NOOP_STORE);

/** Without a provider (a test rendering a sidebar row on its own) the store is empty and inert. */
export function useCompare(): CompareStore {
  return useContext(CompareContext);
}

