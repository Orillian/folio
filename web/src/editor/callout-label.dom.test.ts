// @vitest-environment jsdom
/**
 * Callout headings in live mode (round 22; any type, title and fold since the
 * Obsidian wave).
 *
 * The point of the round was that "NOTE" was the one word on a translated page
 * that stayed English. The point of THIS test is that live mode says it with
 * the same words reading mode does — the markdown zone's `alerts.*` bundle
 * through `calloutDisplayName`, not a second copy living here that could
 * drift — and that Obsidian's `> [!faq]- Title` heads a callout the same way.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import i18next from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { UI_LANGUAGES } from '../i18n/languages';
import { calloutDisplayName } from '../markdown/alerts';
import { t as markdownT } from '../markdown/i18n/register';
import { CALLOUT_TYPES } from './live-decorations';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';
import { CalloutLabelWidget, calloutLabel } from './widgets';

/** The heading of a plain, untitled, non-foldable callout of this kind. */
const render = (type: (typeof CALLOUT_TYPES)[number]): string =>
  new CalloutLabelWidget(type, type, null, false, i18next.language).toDOM().textContent ?? '';

const views: EditorView[] = [];

function mount(doc: string, live = true, pos = 0): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(live, { space: 'eng', pagePath: 'a.md', pageId: 'P1' }),
      ],
      selection: EditorSelection.single(pos),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

afterEach(async () => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  await i18next.changeLanguage('en');
});

describe('CalloutLabelWidget', () => {
  it('heads a callout in the interface language', async () => {
    expect(render('note')).toBe('Note');
    expect(render('caution')).toBe('Caution');

    const headings = new Set<string>();
    for (const lang of UI_LANGUAGES) {
      await i18next.changeLanguage(lang);
      headings.add(render('note'));
    }
    expect(headings.size).toBe(UI_LANGUAGES.length);
  });

  it('names every alert type in every language', async () => {
    for (const lang of UI_LANGUAGES) {
      await i18next.changeLanguage(lang);
      for (const type of CALLOUT_TYPES) {
        const label = calloutLabel(type);
        // A missing bundle would hand back the key itself.
        expect(label, `${type} in ${lang}`).not.toContain('alerts.');
        expect(label.trim(), `${type} in ${lang}`).not.toBe('');
      }
    }
  });

  it('says exactly what reading mode says', async () => {
    for (const lang of UI_LANGUAGES) {
      await i18next.changeLanguage(lang);
      for (const type of CALLOUT_TYPES) {
        // markdown/alerts.ts writes this very string into `data-alert-label`.
        expect(render(type), `${type} in ${lang}`).toBe(markdownT(`alerts.${type}`));
      }
    }
  });

  it('is rebuilt on a language switch rather than kept from the cache', () => {
    const uk = new CalloutLabelWidget('tip', 'tip', null, false, 'uk');
    expect(uk.eq(new CalloutLabelWidget('tip', 'tip', null, false, 'uk'))).toBe(true);
    expect(uk.eq(new CalloutLabelWidget('tip', 'tip', null, false, 'en'))).toBe(false);
    expect(uk.eq(new CalloutLabelWidget('note', 'tip', null, false, 'uk'))).toBe(false);
  });

  it('is rebuilt when the type word, the fold sign or the title changes', () => {
    const base = new CalloutLabelWidget('note', 'info', '-', false, 'en');
    expect(base.eq(new CalloutLabelWidget('note', 'info', '-', false, 'en'))).toBe(true);
    // Same look, another word: `info` and `faq` are both notes with different names.
    expect(base.eq(new CalloutLabelWidget('note', 'faq', '-', false, 'en'))).toBe(false);
    expect(base.eq(new CalloutLabelWidget('note', 'info', '+', false, 'en'))).toBe(false);
    expect(base.eq(new CalloutLabelWidget('note', 'info', null, false, 'en'))).toBe(false);
    expect(base.eq(new CalloutLabelWidget('note', 'info', '-', true, 'en'))).toBe(false);
  });

  it('keeps the icon beside the name', () => {
    const dom = new CalloutLabelWidget('warning', 'warning', null, false, 'uk').toDOM();
    expect(dom.className).toBe('cm-md-callout__label');
    expect(dom.querySelector('svg')).not.toBeNull();
  });
});

describe('CalloutLabelWidget: Obsidian callouts', () => {
  const dom = (rawType: string, fold: '+' | '-' | null, hasTitle: boolean) =>
    new CalloutLabelWidget('note', rawType, fold, hasTitle, i18next.language).toDOM();

  it('names a type that has a translation in the interface language and a custom one as typed', async () => {
    expect(dom('info', null, false).textContent).toBe('Info');
    expect(dom('my-custom', null, false).textContent).toBe('My-custom');
    for (const lang of UI_LANGUAGES) {
      await i18next.changeLanguage(lang);
      // The very string reading mode heads its callouts with.
      expect(dom('faq', null, false).textContent, lang).toBe(calloutDisplayName('faq'));
      expect(dom('info', null, false).textContent, lang).toBe(markdownT('alerts.info'));
      expect(calloutLabel('danger'), lang).toBe(markdownT('alerts.danger'));
    }
  });

  it('draws the icon of the callout KIND, whatever the type word', () => {
    const icon = (kind: (typeof CALLOUT_TYPES)[number]) =>
      new CalloutLabelWidget(kind, 'x', null, false, 'en').toDOM().querySelector('svg')?.outerHTML;
    // A tip has its own icon; danger folds onto caution and shares the alert icon with warning.
    expect(icon('tip')).not.toBe(icon('note'));
    expect(icon('caution')).toBe(icon('warning'));
  });

  it('leaves the name to the title when the callout has one', () => {
    const titled = dom('info', null, true);
    expect(titled.textContent).toBe('');
    expect(titled.querySelector('svg')).not.toBeNull();
  });

  it('adds a chevron only for a foldable callout, and says which way', () => {
    expect(dom('info', null, false).querySelector('.cm-md-callout__fold')).toBeNull();
    expect(dom('info', '+', false).querySelector('.cm-md-callout__fold')?.getAttribute('data-fold')).toBe('+');
    const closed = dom('info', '-', true).querySelector('.cm-md-callout__fold');
    expect(closed?.getAttribute('data-fold')).toBe('-');
    expect(closed?.getAttribute('aria-hidden')).toBe('true');
    // The chevron is decoration: the name is the only text.
    expect(dom('info', '-', false).textContent).toBe('Info');
  });
});

describe('callouts in a mounted editor', () => {
  it('heads `> [!faq]- Title` with an icon and a chevron, and dresses the title', () => {
    const view = mount('intro\n\n> [!faq]- Why?\n> because\n');
    const label = view.dom.querySelector('.cm-md-callout__label');
    expect(label).not.toBeNull();
    expect(label?.querySelector('[data-fold="-"]')).not.toBeNull();
    expect(label?.textContent).toBe(''); // the title heads it, not the type word
    expect(view.dom.querySelector('.cm-md-callout-title')?.textContent).toBe('Why?');
    expect(view.dom.querySelectorAll('.cm-md-callout-note').length).toBe(2);
  });

  it('names an untitled callout by its type and gives the quote the look of its kind', () => {
    const view = mount('> [!Danger]\n> careful\n');
    expect(view.dom.querySelector('.cm-md-callout__label')?.textContent).toBe('Danger');
    expect(view.dom.querySelector('.cm-md-callout-caution')).not.toBeNull();
    expect(view.dom.querySelector('.cm-md-callout__fold')).toBeNull();
  });

  it('shows the source of the marker while the callout is in source mode', () => {
    const view = mount('> [!info]+ Title\n> body\n', false);
    expect(view.dom.querySelector('.cm-md-callout__label')).toBeNull();
    expect(view.dom.querySelector('.cm-md-callout-title')?.textContent).toBe('Title');
    expect(view.state.doc.toString()).toBe('> [!info]+ Title\n> body\n');
  });
});

describe('Obsidian constructs in a mounted editor', () => {
  const source = [
    'See [[Note|the note]] and ![[img.png|300]] #area/topic',
    '',
    'Hidden %% a *thought* %% and $a*b*c$ here ^anchor',
    '',
    '$$',
    'x^2',
    '$$',
    '',
  ].join('\n');

  const classes = (view: EditorView, cls: string) =>
    [...view.dom.querySelectorAll(`.${cls}`)].map((el) => el.textContent).join('');
  /** The text on screen, one line per `.cm-line`. */
  const rendered = (view: EditorView) =>
    [...view.contentDOM.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n');

  it('dims the syntax and colours what reading mode shows, folding nothing', () => {
    const view = mount(source, true, source.length);
    expect(classes(view, 'cm-md-wikilink')).toContain('the note');
    expect(classes(view, 'cm-md-embed')).toBe('img.png');
    expect(classes(view, 'cm-md-tag')).toBe('#area/topic');
    expect(classes(view, 'cm-md-comment')).toBe('%% a *thought* %%');
    expect(classes(view, 'cm-md-math')).toContain('$a*b*c$');
    expect(classes(view, 'cm-md-math-display')).toContain('x^2');
    expect(classes(view, 'cm-md-blockid')).toBe('^anchor');
    // Not one character of the text is folded away: the rendered text is the document.
    expect(rendered(view)).toBe(source);
  });

  it('draws them the same in source mode', () => {
    const view = mount(source, false, source.length);
    expect(classes(view, 'cm-md-wikilink')).toContain('the note');
    expect(classes(view, 'cm-md-tag')).toBe('#area/topic');
    expect(classes(view, 'cm-md-comment')).toBe('%% a *thought* %%');
    expect(rendered(view)).toBe(source);
  });

  it('does not treat the `[Note]` inside `[[Note]]` as a folded link when a space is typed at its edge', () => {
    // The caret guards (link-guard.ts) move a space typed at the inner edge of a
    // FOLDED link outside of it; a wikilink's brackets are never folded, so the
    // space stays where it was typed.
    const view = mount('go [[Note]] now', true, 5);
    view.dispatch({ changes: { from: 5, insert: ' ' }, userEvent: 'input.type' });
    expect(view.state.doc.toString()).toBe('go [[ Note]] now');

    // An ordinary link next to it still gets the guard.
    const link = mount('go [Note](u) now', true, 4);
    link.dispatch({ changes: { from: 4, insert: ' ' }, userEvent: 'input.type' });
    expect(link.state.doc.toString()).toBe('go  [Note](u) now');
  });

  it('keeps the brackets of `[[Note]]` instead of folding them like a link', () => {
    const view = mount('go to [[Note]] now', true, 0);
    expect(rendered(view)).toBe('go to [[Note]] now');
    expect(view.dom.querySelector('.cm-md-link')).toBeNull();
  });
});
