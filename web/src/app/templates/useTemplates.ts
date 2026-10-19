import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageKind, PageMeta, TemplateListItem, TreeNode } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';

export interface TemplateOption {
  id: string;
  title: string;
  kind: PageKind;
  /** The template's emoji icon from its frontmatter, if any. */
  icon?: string;
  /** The template's description (its `template-description` property), if any. */
  description?: string;
}

/**
 * Templates available for "From template…": the top-level pages of the
 * space's `_templates/` folder, of any kind (GET /api/spaces/:space/templates).
 * `enabled` lets a caller fetch only once the picker is actually opened.
 */
export function useTemplates(space: string, enabled = true) {
  const query = useQuery({
    queryKey: ['templates', space],
    queryFn: () => api.getTemplates(space),
    enabled,
  });
  const templates: TemplateOption[] = (query.data?.templates ?? []).map((p: TemplateListItem) => ({
    id: p.id,
    title: p.title,
    kind: p.kind,
    icon: p.icon,
    description: p.description,
  }));
  return { templates, isLoading: query.isLoading, isError: query.isError, refetch: query.refetch };
}

/** The whole `_templates/` tree (templates with their subpages) for the sidebar's Templates section; fetched only when `enabled`. */
export function useTemplatesTree(space: string, enabled: boolean) {
  return useQuery<TreeNode[]>({
    queryKey: ['templates-tree', space],
    queryFn: () => api.getTemplatesTree(space),
    enabled,
  });
}

/** After anything that adds, renames or removes a template. */
export function invalidateTemplates(queryClient: ReturnType<typeof useQueryClient>, space: string) {
  queryClient.invalidateQueries({ queryKey: ['templates', space] });
  queryClient.invalidateQueries({ queryKey: ['templates-tree', space] });
}

export interface CreateFromTemplateArgs {
  template: TemplateOption;
  /** Parent directory path relative to the space root; "" for space root — same shape as CreatePageBody.parentPath. */
  parentPath: string;
}

/**
 * Creates a page (with its subpages) from a template in one server call:
 * the server copies the template and fills {{date}}/{{author}}/{{title}}.
 * The new page keeps the template's own title, like any other
 * quick-created page — there is no "name your page" prompt in this flow.
 */
export function useCreateFromTemplate(space: string, onSuccess: (page: PageMeta) => void, onError: (message: string) => void) {
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ template, parentPath }: CreateFromTemplateArgs) => api.createFromTemplate({ templateId: template.id, space, parentPath }),
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
      onSuccess(page);
    },
    onError: (err) => onError(errorText(err, 'sidebar.templates.createFailed')),
  });
}
