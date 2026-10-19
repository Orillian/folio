/**
 * A template's description (the owner, 19.10.2026): the `template-description`
 * property of the template's root page — a plain property, so it is edited in
 * the properties panel like any other. Set when a template is made, listed
 * with the templates, and removed from the root of a page created from one.
 */
import { TEMPLATE_DESCRIPTION_KEY } from '../shared/contracts.js';
import type { User } from '../shared/contracts.js';
import { mergePropertyPatch, propertiesStoreOf, readPageProperties, updatePageProperties } from './properties.js';
import * as storage from './storage.js';

type Actor = Pick<User, 'name' | 'email'>;

/** Sets (`description` non-empty) or removes the description property on `pageId`; a page without properties (a folder) is left alone. */
async function writeDescription(pageId: string, description: string | null, actor: Actor): Promise<void> {
  const entry = await storage.requireEntry(pageId);
  if (propertiesStoreOf(entry.kind) === 'none') return;
  const current = await readPageProperties(entry, true);
  if (!current.canEdit) return;
  const has = Object.prototype.hasOwnProperty.call(current.properties, TEMPLATE_DESCRIPTION_KEY);
  if (description === null && !has) return;
  const properties = mergePropertyPatch(entry.kind, current.properties, { [TEMPLATE_DESCRIPTION_KEY]: description });
  await updatePageProperties(pageId, { properties, etag: current.etag }, true, { name: actor.name, email: actor.email });
}

export const setTemplateDescription = (pageId: string, description: string, actor: Actor): Promise<void> => writeDescription(pageId, description, actor);

/** The copy of a template must not announce itself as one. */
export const clearTemplateDescription = (pageId: string, actor: Actor): Promise<void> => writeDescription(pageId, null, actor);
