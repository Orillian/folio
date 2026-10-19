/**
 * The sidebar's Templates section remembers whether it is open per space, in localStorage. Making a template
 * opens it so the new template is in sight; the section may be mounted (listens for the event) or not (the
 * stored flag is what it reads when it mounts).
 */
export const OPEN_TEMPLATES_SECTION_EVENT = 'folio:open-templates-section';

export function templatesSectionOpenKey(space: string): string {
  return `folio:templates-section-open:${space}`;
}

export function openTemplatesSection(space: string): void {
  try {
    localStorage.setItem(templatesSectionOpenKey(space), 'true');
  } catch {
    // Storage unavailable: the event below still opens a mounted section.
  }
  window.dispatchEvent(new CustomEvent(OPEN_TEMPLATES_SECTION_EVENT, { detail: { space } }));
}
