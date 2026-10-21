import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { bundlesFrom } from '../../i18n/bundles';
import { STANDALONE_LANGUAGE } from '../../i18n/standalone';

/**
 * Artifacts — mirrors web/src/forms/i18n/register.ts: this zone owns and
 * registers its own 'artifact' bundle at import time, idempotently. Kept apart
 * from the 'app' namespace on purpose — the artifact view is mounted from the
 * page route, the share view and the public site alike.
 */
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    lng: STANDALONE_LANGUAGE,
    fallbackLng: STANDALONE_LANGUAGE,
    ns: ['artifact'],
    defaultNS: 'artifact',
    resources: {},
    interpolation: { escapeValue: false },
  });
}

const NS = 'artifact';
// Every language that has a bundle next to this file.
const bundles = bundlesFrom(import.meta.glob('./*.json', { eager: true, import: 'default' }));

for (const [lang, bundle] of Object.entries(bundles)) {
  if (!i18next.hasResourceBundle(lang, NS)) {
    i18next.addResourceBundle(lang, NS, bundle);
  }
}
