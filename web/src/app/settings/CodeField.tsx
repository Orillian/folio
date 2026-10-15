import { useEffect, useImperativeHandle, useRef } from 'react';
import type { Ref } from 'react';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder as placeholderExtension } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { tags as t } from '@lezer/highlight';

export interface CodeFieldHandle {
  /** Replaces the selection (or inserts at the caret) and puts the caret after the text. */
  insertAtCursor: (text: string) => void;
  focus: () => void;
}

export interface CodeFieldProps {
  value: string;
  onChange: (value: string) => void;
  language: 'css' | 'html';
  /** Accessible name of the editable area. */
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  lineNumbers?: boolean;
  /** Sizes the box (e.g. `h-40`); the editor fills it and scrolls inside. */
  className?: string;
  ref?: Ref<CodeFieldHandle>;
}

/** A change that comes from the `value` prop, not from the person typing: it must not echo back through onChange. */
const External = Annotation.define<boolean>();

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.atom, t.tagName, t.controlKeyword], color: 'var(--cf-keyword)' },
  { tag: [t.string, t.special(t.string), t.attributeValue], color: 'var(--cf-string)' },
  { tag: [t.number, t.unit, t.color], color: 'var(--cf-number)' },
  { tag: [t.propertyName, t.attributeName, t.className], color: 'var(--cf-prop)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--cf-comment)', fontStyle: 'italic' },
  { tag: [t.punctuation, t.bracket, t.operator, t.angleBracket], color: 'var(--cf-muted)' },
  { tag: t.invalid, color: 'var(--cf-danger)' },
]);

/** Colors come from custom properties set on the wrapper, so light and dark follow the app's `dark:` variant. */
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--cf-fg)', backgroundColor: 'var(--cf-bg)', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.55', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--cf-fg)', padding: '6px 0' },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': { backgroundColor: 'var(--cf-bg)', color: 'var(--cf-muted)', border: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--cf-fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--cf-selection)' },
  '.cm-placeholder': { color: 'var(--cf-muted)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--cf-selection)', outline: 'none' },
});

const WRAPPER_COLORS =
  '[--cf-fg:#1c1917] [--cf-bg:#ffffff] [--cf-muted:#78716c] [--cf-selection:#d6d3d1] [--cf-keyword:#7c3aed] [--cf-string:#0f766e] [--cf-number:#b45309] [--cf-prop:#1d4ed8] [--cf-comment:#a8a29e] [--cf-danger:#dc2626] ' +
  'dark:[--cf-fg:#e7e5e4] dark:[--cf-bg:#0a0a0a] dark:[--cf-muted:#a8a29e] dark:[--cf-selection:#44403c] dark:[--cf-keyword:#c4b5fd] dark:[--cf-string:#5eead4] dark:[--cf-number:#fbbf24] dark:[--cf-prop:#93c5fd] dark:[--cf-comment:#78716c] dark:[--cf-danger:#f87171]';

/**
 * A small CodeMirror 6 editor for one text file (CSS or HTML): syntax colors, history, search-free,
 * and no Tab trap (Tab still moves focus on). Controlled by `value`; the parent owns the text.
 */
export function CodeField({ value, onChange, language, ariaLabel, placeholder, disabled, lineNumbers: withLineNumbers, className, ref }: CodeFieldProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editable = useRef(new Compartment());

  useImperativeHandle(
    ref,
    () => ({
      insertAtCursor(text: string) {
        const editor = view.current;
        if (!editor) return;
        const { from, to } = editor.state.selection.main;
        editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' });
        editor.focus();
      },
      focus() {
        view.current?.focus();
      },
    }),
    [],
  );

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      language === 'css' ? css() : html(),
      syntaxHighlighting(highlight),
      theme,
      bracketMatching(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false', autocapitalize: 'none', autocorrect: 'off' }),
      editable.current.of([EditorView.editable.of(!disabled), EditorState.readOnly.of(Boolean(disabled))]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.some((tr) => tr.annotation(External))) return;
        onChangeRef.current(update.state.doc.toString());
      }),
    ];
    if (withLineNumbers) extensions.push(lineNumbers());
    if (placeholder) extensions.push(placeholderExtension(placeholder));
    const editor = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: host.current });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The editor is built once per language/label; `value` and `disabled` are synced by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, ariaLabel, withLineNumbers, placeholder]);

  // The text changed from outside (a reload, "keep the repository's version"): replace it without echoing.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value }, annotations: External.of(true) });
  }, [value, language, ariaLabel, withLineNumbers, placeholder]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorView.editable.of(!disabled), EditorState.readOnly.of(Boolean(disabled))]) });
  }, [disabled]);

  return (
    <div
      ref={host}
      className={`overflow-hidden rounded-md border border-neutral-300 focus-within:border-neutral-500 dark:border-neutral-700 ${WRAPPER_COLORS} ${className ?? 'h-40'}`}
    />
  );
}
