import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { bundlesFrom } from '../../i18n/bundles';
import { STANDALONE_LANGUAGE } from '../../i18n/standalone';

/**
 * Obsidian Bases — mirrors web/src/forms/i18n/register.ts: this zone owns and
 * registers its own 'bases' bundle at import time, idempotently. Kept apart
 * from the 'app' namespace on purpose — the base view is mounted from the
 * page route and from documents (```base blocks).
 */
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    lng: STANDALONE_LANGUAGE,
    fallbackLng: STANDALONE_LANGUAGE,
    ns: ['bases'],
    defaultNS: 'bases',
    resources: {},
    interpolation: { escapeValue: false },
  });
}

const NS = 'bases';
// Every language that has a bundle next to this file.
const bundles = bundlesFrom(import.meta.glob('./*.json', { eager: true, import: 'default' }));

for (const [lang, bundle] of Object.entries(bundles)) {
  if (!i18next.hasResourceBundle(lang, NS)) {
    i18next.addResourceBundle(lang, NS, bundle);
  }
}
