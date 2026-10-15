/**
 * Formulas in the reading view (Obsidian vault compatibility, wave 2): the
 * pipeline leaves `<span class="folio-math" data-math="TeX">$TeX$</span>`
 * (shared/ofm/remark.ts; a block one is a `div`), and this draws them with
 * KaTeX. KaTeX and its stylesheet/fonts load on first use only - a page with no
 * formula never pays for them. Until they arrive (or if TeX is invalid, or
 * the library cannot load) the element keeps showing the TeX as written, in a
 * code-like font - degrade, never break.
 */

export async function renderMath(root: HTMLElement): Promise<void> {
  const pending = Array.from(root.querySelectorAll<HTMLElement>('[data-math]:not([data-math-done])'));
  if (pending.length === 0) return;
  try {
    const [{ default: katex }] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')]);
    for (const el of pending) {
      if (!el.isConnected) continue;
      try {
        katex.render(el.getAttribute('data-math') ?? '', el, {
          displayMode: el.classList.contains('folio-math-display'),
          throwOnError: false,
          output: 'htmlAndMathml',
        });
        el.setAttribute('data-math-done', '1');
      } catch {
        // invalid TeX: the source text stays
      }
    }
  } catch {
    // KaTeX could not be loaded (offline chunk): the source text stays
  }
}
