/**
 * Starter templates written into the `_templates/` folder of a NEW empty space
 * (storage.createSpace with `starterTemplates`). Ordinary docs: the H1 is the
 * template's name, the {{date}}/{{author}} placeholders are filled when a page
 * is created from it (server/templateVars.ts). Files are named in English in
 * every language; the text comes from the server bundles (server/i18n,
 * `starterTemplate.<stem>`).
 */
import { serverText } from './serverText.js';

export type StarterLanguage = 'en' | 'uk';

export interface StarterTemplate {
  /** File stem inside `_templates/`. */
  stem: string;
  icon: string;
  markdown: string;
  /** The template's `template-description` property: the second line in the template picker. */
  description: string;
}

const STARTERS = [
  { stem: 'meeting-notes', icon: '📝' },
  { stem: 'how-to', icon: '🧭' },
  { stem: 'decision-record', icon: '⚖️' },
] as const;

export function starterTemplates(language: StarterLanguage = 'en'): StarterTemplate[] {
  return STARTERS.map(({ stem, icon }) => ({
    stem,
    icon,
    markdown: serverText(`starterTemplate.${stem}`, language),
    description: serverText(`starterTemplate.${stem}.description`, language),
  }));
}
