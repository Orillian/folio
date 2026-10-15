import { calloutKind, capitalizeType, hasCalloutName, type CalloutKind } from '@shared/ofm/callout';
import { t } from './i18n/register';

/**
 * Callouts, web side. The grammar (which `> [!type]` is a callout, any type
 * and case, fold sign, title) and the table that folds Obsidian's types onto
 * Folio's five looks are shared/ofm/callout.ts; the transform itself is
 * shared/ofm/remark.ts (`remarkOfm`, run by pipeline.ts) — GitHub's five
 * alerts and Obsidian's callouts are the same thing there. What is left here
 * is the one thing that needs the interface language.
 */

/** GFM alert kinds, in the order GitHub documents them, uppercase as GitHub writes them. */
export const ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export type { CalloutKind };
export { calloutKind };

/**
 * The visible name of a callout of this type, in the interface language: the
 * translated name when the type has one (`alerts.<type>` of the markdown
 * bundle), otherwise the type as the author wrote it, capitalized — the way
 * Obsidian shows `[!my-custom]`.
 *
 * Round 22 (SHELL-5): resolved through the non-React `t()` because it runs
 * inside a plain unified transform and in a CodeMirror widget, neither of
 * which is a component. markdown/index.tsx lists `i18n.language` among the
 * render memo's dependencies so a language switch redraws the labels.
 */
export function calloutDisplayName(type: string): string {
  const lower = type.toLowerCase();
  return hasCalloutName(lower) ? t(`alerts.${lower}`) : capitalizeType(type);
}
