import { createContext } from 'react';

/**
 * Where a page without the document editor's chrome row (a board, a data table, a form, a PDF / Office file) mounts its
 * "Properties (N)" toggle: an empty slot in the shell's header, right after the breadcrumbs. Shell owns the element
 * (Header renders it), the routed page reaches it through this context and portals into it. `undefined` without a shell
 * (tests, a standalone render) — the caller then renders the toggle where it stands; `null` while the shell's slot is
 * not mounted yet — the caller renders nothing for that moment.
 */
export const PropertiesSlotContext = createContext<HTMLElement | null | undefined>(undefined);
