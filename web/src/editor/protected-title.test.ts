import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureProtectedPageTitle, protectPageTitle } from './protected-title';

describe('protected page title', () => {
  it('repairs an erased title without losing the body', () => {
    expect(ensureProtectedPageTitle('Body\n', 'Page')).toBe('# Page\n\nBody\n');
    expect(ensureProtectedPageTitle('#   \nBody', 'Page')).toBe('# Page\nBody');
  });

  it('takes an H1 below blank lines as the title (no duplicate), and never eats a `##` line', () => {
    expect(ensureProtectedPageTitle('\n# Tabs\n\nBody', 'Tabs')).toBe('\n# Tabs\n\nBody');
    expect(ensureProtectedPageTitle('\n\n# Tabs', 'Other')).toBe('\n\n# Tabs');
    expect(ensureProtectedPageTitle('## Section\n\nBody', 'Page')).toBe('# Page\n\n## Section\n\nBody');
  });

  it('does not guard a page whose first line is not its H1: a blank line above the heading stays editable', () => {
    let state = EditorState.create({ doc: '\n# Tabs\n\nBody', extensions: [protectPageTitle()] });
    state = state.update({ changes: { from: state.doc.length, insert: ' more' }, userEvent: 'input.type' }).state;
    expect(state.doc.toString()).toBe('\n# Tabs\n\nBody more');
    state = state.update({ changes: { from: 0, to: 1 }, userEvent: 'delete.backward' }).state;
    expect(state.doc.toString()).toBe('# Tabs\n\nBody more');
  });

  it('allows renaming but rejects deleting H1 and its line boundary', () => {
    let state = EditorState.create({ doc: '# Old\n\nBody', extensions: [protectPageTitle()] });
    state = state.update({ changes: { from: 2, to: 5, insert: 'New' }, userEvent: 'input.type' }).state;
    expect(state.doc.toString()).toBe('# New\n\nBody');

    // Cutting the whole first line (marker included) clears the title for
    // retyping — the marker itself comes back, the body stays.
    state = state.update({ changes: { from: 0, to: 5 }, userEvent: 'delete.cut' }).state;
    expect(state.doc.toString()).toBe('# \n\nBody');
    state = state.update({ changes: { from: 2, insert: 'New' }, userEvent: 'input.type' }).state;
    expect(state.doc.toString()).toBe('# New\n\nBody');

    // Joining the title with the paragraph below is still refused.
    state = state.update({ changes: { from: 5, to: 6 }, userEvent: 'delete.backward' }).state;
    expect(state.doc.toString()).toBe('# New\n\nBody');
  });

  it('Ctrl+A → Delete clears the body but keeps the title; paste over everything keeps it too', () => {
    let state = EditorState.create({ doc: '# Old\n\nBody text', extensions: [protectPageTitle()] });
    state = state.update({ changes: { from: 0, to: state.doc.length }, userEvent: 'delete.selection' }).state;
    expect(state.doc.toString()).toBe('# Old\n\n');
    expect(state.selection.main.head).toBe('# Old\n\n'.length);

    state = state.update({ changes: { from: 0, to: state.doc.length, insert: 'pasted **md**\n- item' }, userEvent: 'input.paste' }).state;
    expect(state.doc.toString()).toBe('# Old\n\npasted **md**\n- item');

    // A pasted document that brings its own H1 is taken as-is.
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: '# Fresh\n\nnew body' }, userEvent: 'input.paste' }).state;
    expect(state.doc.toString()).toBe('# Fresh\n\nnew body');
  });

  it('lets the title be emptied to retype it, and puts the marker back when it was typed over', () => {
    let state = EditorState.create({ doc: '# Old\n\nBody', extensions: [protectPageTitle()] });
    // Backspace over the whole title text: «# » alone is allowed mid-rename.
    state = state.update({ changes: { from: 2, to: 5 }, userEvent: 'delete.backward' }).state;
    expect(state.doc.toString()).toBe('# \n\nBody');
    state = state.update({ changes: { from: 2, insert: 'Fresh' }, userEvent: 'input.type' }).state;
    expect(state.doc.toString()).toBe('# Fresh\n\nBody');
    // Whole first line (marker included) selected and typed over: marker restored.
    state = state.update({ changes: { from: 0, to: 7, insert: 'Typed' }, userEvent: 'input.type' }).state;
    expect(state.doc.toString()).toBe('# Typed\n\nBody');
  });
});
