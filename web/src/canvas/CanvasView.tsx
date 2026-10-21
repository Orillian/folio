/**
 * The Obsidian canvas renderer (JSON Canvas 1.0) — read-only, lazy-loaded
 * (CanvasPage.tsx imports it with React.lazy, so nobody downloads it before a
 * canvas is opened).
 *
 * DOM, not a <canvas>: cards are absolutely positioned boxes inside one
 * transformed "world" layer, so text cards are real Markdown (Folio's own
 * reading pipeline, OFM included), selectable and with working links. Edges are
 * one SVG under the cards (shared/canvas/geometry.ts draws Obsidian's curves),
 * groups a layer under both.
 *
 * Navigation: drag (mouse, pen, one finger) pans; the wheel pans, Ctrl/⌘ +
 * wheel and a trackpad / two-finger pinch zoom around the pointer; `+` `-`
 * zoom, `0` is 100%, `1` fits. The first view is a fit — taken only once the
 * container has a real size (renderModel.initialView returns null before), and
 * clamped to 10%..100% (a tiny canvas is not blown up, a huge one is not shrunk
 * to dust).
 *
 * Cards: a click selects (and lets a long card scroll inside), a double click
 * or the label opens a note card's page. Only the cards near the viewport are
 * mounted; below LITE_ZOOM a text card shows its first line only.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { FileText, Globe, Lock, Maximize, Minus, Paperclip, Plus, TriangleAlert, LayoutDashboard, Table2, ClipboardList, FileType2, FileSpreadsheet, Map as MapIcon, Folder, Database, AppWindow } from 'lucide-react';
import type { CanvasFileTarget, CanvasNode, CanvasPayload, PageKind } from '@shared/contracts';
import { clampZoom, zoomAround, type CanvasColorScheme } from '@shared/canvas/index';
import { Markdown, type MarkdownPublicSite } from '../markdown';
import { useColorScheme } from '../diagrams/colorScheme';
import {
  cardColors,
  edgeModels,
  initialView,
  layers,
  LITE_ZOOM,
  previewLine,
  safeExternalUrl,
  urlDomain,
  visibleCards,
  type CanvasView as View,
} from './renderModel';
import './canvas.css';
import './i18n/register';

export interface CanvasViewProps {
  payload: CanvasPayload;
  /** The canvas page itself: its text cards' links resolve against it. */
  pageId: string;
  space: string;
  pagePath: string;
  /** In-app URL of a page a file card points at; null (or absent) = cards do not navigate here (a share link). */
  pageHref?: (pageId: string) => string | null;
  /** URL of a file of the space (images, audio, video, attachments). */
  fileUrl: (relPath: string) => string;
  /** URL of a PDF page's bytes for its preview; null = no preview, a plain card. */
  pdfUrl?: (pageId: string, relPath: string) => string | null;
  shareToken?: string;
  publicSite?: MarkdownPublicSite;
  /** Extra toolbar buttons (the page adds "Convert to Folio board"). */
  toolbarExtra?: ReactNode;
}

type Gesture =
  | { kind: 'pan'; pointerId: number; start: { x: number; y: number }; view0: View; moved: boolean }
  | { kind: 'pinch'; d0: number; mid0: { x: number; y: number }; view0: View };

const DRAG_THRESHOLD = 4;
const KEY_ZOOM = 1.2;

/** Elements that keep their own pointer behaviour (no pan starts on them). */
function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('a, button, input, textarea, select, audio, video, iframe, summary, [data-canvas-own-pointer]') !== null;
}

export default function CanvasView(props: CanvasViewProps) {
  const { payload, toolbarExtra } = props;
  const { t } = useTranslation('canvas');
  const scheme = useColorScheme();
  const doc = payload.document!;
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;
  const [selected, setSelected] = useState<string | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);

  // The container's size: the fit waits for a real one.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (!size) return;
    const v = initialView(doc, size.w, size.h);
    if (v) setView(v);
  }, [doc, size]);

  useEffect(() => {
    if (view || !size) return;
    const v = initialView(doc, size.w, size.h);
    if (v) setView(v);
  }, [doc, size, view]);

  const zoomBy = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      setView((v) => (v ? zoomAround(v, factor, at ?? { x: (size?.w ?? 0) / 2, y: (size?.h ?? 0) / 2 }) : v));
    },
    [size],
  );
  const zoomTo = useCallback(
    (zoom: number) => {
      setView((v) => (v ? zoomAround(v, clampZoom(zoom) / v.zoom, { x: (size?.w ?? 0) / 2, y: (size?.h ?? 0) / 2 }) : v));
    },
    [size],
  );

  // Wheel: a non-passive listener, or preventDefault would be ignored and the page would scroll / the browser zoom.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (!v) return;
      // A selected card that can scroll keeps the wheel for itself.
      const body = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-canvas-scroll="true"]') : null;
      if (body && !e.ctrlKey && !e.metaKey) {
        const canScroll = e.deltaY < 0 ? body.scrollTop > 0 : body.scrollTop + body.clientHeight < body.scrollHeight - 1;
        if (canScroll) return;
      }
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      if (e.ctrlKey || e.metaKey) {
        setView(zoomAround(v, Math.exp((-e.deltaY * unit) / 400), at));
      } else {
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        setView({ ...v, x: v.x - dx * unit, y: v.y - dy * unit });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = rootRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!view) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (isInteractive(e.target)) return;
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) {
      gesture.current = { kind: 'pan', pointerId: e.pointerId, start: local(e), view0: view, moved: false };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view0: view };
      rootRef.current?.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan' && g.pointerId === e.pointerId) {
      const dx = p.x - g.start.x;
      const dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!g.moved) {
        g.moved = true;
        rootRef.current?.setPointerCapture(e.pointerId);
      }
      setView({ ...g.view0, x: g.view0.x + dx, y: g.view0.y + dy });
    } else if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zoomed = zoomAround(g.view0, d / g.d0, g.mid0);
      setView({ ...zoomed, x: zoomed.x + (mid.x - g.mid0.x), y: zoomed.y + (mid.y - g.mid0.y) });
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'pan' && g.moved) suppressClick.current = true;
    if (g?.kind === 'pinch') suppressClick.current = true;
    if (pointers.current.size === 0) gesture.current = null;
    else if (g?.kind === 'pinch' && view) {
      // One finger left after a pinch: keep panning with it from here.
      const [id, p] = [...pointers.current.entries()][0];
      gesture.current = { kind: 'pan', pointerId: id, start: p, view0: view, moved: true };
    }
  };

  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== rootRef.current) return;
    if (e.key === '+' || e.key === '=') zoomBy(KEY_ZOOM);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / KEY_ZOOM);
    else if (e.key === '0') zoomTo(1);
    else if (e.key === '1') fit();
    else if (e.key === 'Escape') setSelected(null);
    else return;
    e.preventDefault();
  };

  const { groups, cards } = useMemo(() => layers(doc), [doc]);
  const edges = useMemo(() => edgeModels(doc, scheme), [doc, scheme]);
  const shown = useMemo(() => (view && size ? visibleCards(cards, view, size.w, size.h) : []), [cards, view, size]);
  const lite = (view?.zoom ?? 1) < LITE_ZOOM;
  const dot = view ? Math.max(8, 20 * view.zoom) : 20;

  return (
    <div
      ref={rootRef}
      className="folio-canvas"
      tabIndex={0}
      role="application"
      aria-roledescription="canvas"
      style={view ? { backgroundSize: `${dot}px ${dot}px`, backgroundPosition: `${view.x}px ${view.y}px` } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onClickCapture={onClickCapture}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as Element).classList?.contains('folio-canvas-world')) setSelected(null);
      }}
      onKeyDown={onKeyDown}
    >
      {view && (
        <div className="folio-canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          {groups.map((g) => (
            <GroupBox key={g.id} node={g} scheme={scheme} background={payload.backgrounds[g.id]} fileUrl={props.fileUrl} />
          ))}
          <svg className="folio-canvas-edges" width="1" height="1" aria-hidden="true">
            {edges.map((edge) => {
              const stroke = edge.color ?? 'var(--cv-edge)';
              return (
                <g key={edge.id}>
                  <path d={edge.path} fill="none" stroke={stroke} strokeWidth={3} strokeLinecap="round" />
                  {edge.startArrow && <polygon points={edge.startArrow} fill={stroke} />}
                  {edge.endArrow && <polygon points={edge.endArrow} fill={stroke} />}
                </g>
              );
            })}
          </svg>
          {shown.map((node) => (
            <Card key={node.id} node={node} scheme={scheme} lite={lite} selected={selected === node.id} onSelect={setSelected} target={node.type === 'file' ? payload.files[node.id] : undefined} {...props} />
          ))}
          {edges.map((edge) =>
            edge.label ? (
              <div
                key={`label-${edge.id}`}
                className="folio-canvas-edge-label"
                style={{ left: edge.labelAt.x, top: edge.labelAt.y, ...(edge.color ? { color: edge.color } : {}) }}
              >
                {edge.label}
              </div>
            ) : null,
          )}
        </div>
      )}
      {doc.nodes.length === 0 && <div className="folio-canvas-center absolute inset-0">{t('empty')}</div>}
      <div className="folio-canvas-toolbar" data-canvas-own-pointer onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => zoomBy(1 / KEY_ZOOM)} title={t('toolbar.zoomOut')} aria-label={t('toolbar.zoomOut')}>
          <Minus size={16} />
        </button>
        <button type="button" className="folio-canvas-zoom" onClick={() => zoomTo(1)} title={t('toolbar.zoomReset')} aria-label={t('toolbar.zoomReset')}>
          {Math.round((view?.zoom ?? 1) * 100)}%
        </button>
        <button type="button" onClick={() => zoomBy(KEY_ZOOM)} title={t('toolbar.zoomIn')} aria-label={t('toolbar.zoomIn')}>
          <Plus size={16} />
        </button>
        <button type="button" onClick={fit} title={t('toolbar.fit')} aria-label={t('toolbar.fit')}>
          <Maximize size={16} />
        </button>
        {toolbarExtra}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function GroupBox({
  node,
  scheme,
  background,
  fileUrl,
}: {
  node: Extract<CanvasNode, { type: 'group' }>;
  scheme: CanvasColorScheme;
  background: CanvasFileTarget | undefined;
  fileUrl: (p: string) => string;
}) {
  const colors = cardColors(node.color, scheme, 'group');
  const image = background?.status === 'file' ? `url("${fileUrl(background.path).replace(/"/g, '%22')}")` : undefined;
  const style = node.backgroundStyle ?? 'cover';
  return (
    <div
      className="folio-canvas-group"
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        ...(colors.border ? { borderColor: colors.border, backgroundColor: colors.fill } : {}),
        ...(image
          ? {
              backgroundImage: image,
              backgroundSize: style === 'repeat' ? 'auto' : style === 'ratio' ? 'contain' : 'cover',
              backgroundRepeat: style === 'repeat' ? 'repeat' : 'no-repeat',
            }
          : {}),
      }}
    >
      {node.label && (
        <div className="folio-canvas-group-label" style={colors.labelFill ? { background: colors.labelFill } : undefined}>
          {node.label}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

type CardProps = CanvasViewProps & {
  node: CanvasNode;
  scheme: CanvasColorScheme;
  lite: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  target: CanvasFileTarget | undefined;
};

const KIND_ICON: Record<PageKind, typeof FileText> = {
  doc: FileText,
  board: LayoutDashboard,
  table: Table2,
  form: ClipboardList,
  pdf: FileType2,
  office: FileSpreadsheet,
  canvas: MapIcon,
  base: Database,
  artifact: AppWindow,
  folder: Folder,
};

const Card = memo(function Card(props: CardProps) {
  const { node, scheme, selected, onSelect } = props;
  const navigate = useNavigate();
  const colors = cardColors(node.color, scheme);
  const href = props.target?.status === 'page' ? (props.pageHref?.(props.target.pageId) ?? null) : null;
  const label = cardLabel(props);
  return (
    <div
      className="folio-canvas-card"
      data-selected={selected ? 'true' : undefined}
      data-card-type={node.type}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height, ...(colors.border ? { borderColor: colors.border } : {}) }}
      onClick={() => onSelect(node.id)}
      onDoubleClick={() => {
        if (href) navigate(href);
      }}
    >
      {colors.fill && <div className="folio-canvas-card-fill" style={{ background: colors.fill }} />}
      {label && <div className="folio-canvas-card-label">{href ? <a href={href} onClick={(e) => { e.preventDefault(); navigate(href); }}>{label}</a> : label}</div>}
      <CardBody {...props} href={href} />
    </div>
  );
});

/** The small label above a file card: the note's title / the file's name (Obsidian shows the file name there). */
function cardLabel(props: CardProps): string | null {
  const { node, target } = props;
  if (node.type !== 'file' || !target) return null;
  if (target.status === 'page') return target.title + (node.subpath ? ` › ${node.subpath.replace(/^#\^?/, '')}` : '');
  if (target.status === 'file' || target.status === 'missing') return target.path.split('/').pop() ?? target.path;
  return null;
}

function CardBody(props: CardProps & { href: string | null }) {
  const { node, lite, selected, target, href } = props;
  const { t } = useTranslation('canvas');
  const navigate = useNavigate();
  if (node.type === 'text') {
    if (lite) return <div className="folio-canvas-lite">{previewLine(node.text)}</div>;
    return (
      <div className="folio-canvas-card-body" data-canvas-scroll={selected ? 'true' : undefined}>
        <CardMarkdown markdown={node.text} space={props.space} pagePath={props.pagePath} pageId={props.pageId} shareToken={props.shareToken} publicSite={props.publicSite} />
      </div>
    );
  }
  if (node.type === 'link') {
    const safe = safeExternalUrl(node.url);
    return (
      <div className="folio-canvas-center">
        <Globe size={28} aria-hidden="true" />
        <div style={{ fontWeight: 600, fontSize: 18, color: 'var(--cv-card-fg)' }}>{urlDomain(node.url)}</div>
        {safe ? (
          <a href={safe} target="_blank" rel="noopener noreferrer nofollow" style={{ wordBreak: 'break-all', textDecoration: 'underline' }} title={t('card.openLink')}>
            {node.url}
          </a>
        ) : (
          <span style={{ wordBreak: 'break-all' }}>{node.url}</span>
        )}
      </div>
    );
  }
  if (node.type !== 'file') return null;
  if (!target || target.status === 'noAccess') {
    return (
      <div className="folio-canvas-center">
        <Lock size={24} aria-hidden="true" />
        <span>{t('card.noAccess')}</span>
      </div>
    );
  }
  if (target.status === 'missing') {
    return (
      <div className="folio-canvas-center">
        <TriangleAlert size={24} aria-hidden="true" />
        <span>{t('card.missing')}</span>
        <code style={{ fontSize: 12, wordBreak: 'break-all' }}>
          {target.path}
          {node.subpath ?? ''}
        </code>
      </div>
    );
  }
  if (target.status === 'file') {
    const url = props.fileUrl(target.path);
    if (target.media === 'image') return <img className="folio-canvas-media" src={url} alt={target.path} loading="lazy" draggable={false} />;
    if (target.media === 'audio')
      return (
        <div className="folio-canvas-center">
          <audio controls src={url} preload="none" style={{ width: '100%' }} />
        </div>
      );
    if (target.media === 'video') return <video className="folio-canvas-media" style={{ pointerEvents: 'auto' }} controls src={url} preload="metadata" />;
    return (
      <div className="folio-canvas-center">
        <Paperclip size={24} aria-hidden="true" />
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ wordBreak: 'break-all', textDecoration: 'underline' }}>
          {target.path.split('/').pop()}
        </a>
      </div>
    );
  }
  // A page.
  const Icon = KIND_ICON[target.kind] ?? FileText;
  if (target.kind === 'doc' && target.excerpt !== undefined && !lite) {
    return (
      <div className="folio-canvas-card-body" data-canvas-scroll={selected ? 'true' : undefined}>
        {target.subpathMissing && <p style={{ fontSize: 12, color: 'var(--cv-muted)', margin: '0 0 6px' }}>{t('card.subpathMissing')}</p>}
        {target.excerpt.trim() ? (
          <CardMarkdown markdown={target.excerpt} space={props.space} pagePath={target.path} pageId={target.pageId} shareToken={props.shareToken} publicSite={props.publicSite} />
        ) : (
          <p style={{ color: 'var(--cv-muted)' }}>{t('card.emptyNote')}</p>
        )}
        {target.excerptTruncated && <p style={{ color: 'var(--cv-muted)' }}>…</p>}
      </div>
    );
  }
  const pdf = target.kind === 'pdf' && !lite ? (props.pdfUrl?.(target.pageId, target.path) ?? null) : null;
  if (pdf && node.width >= 200 && node.height >= 200) {
    // Clicks go to the card (select / open) until it is selected; then the frame is the reader's.
    return <iframe className="folio-canvas-media" src={pdf} title={target.title} style={{ pointerEvents: selected ? 'auto' : 'none', border: 0 }} />;
  }
  return (
    <div className="folio-canvas-center">
      {target.icon ? <span style={{ fontSize: 28 }}>{target.icon}</span> : <Icon size={28} aria-hidden="true" />}
      <div style={{ fontWeight: 600, fontSize: 18, color: 'var(--cv-card-fg)' }}>{target.title}</div>
      <div style={{ fontSize: 12 }}>{t(`card.kind.${target.kind}`)}</div>
      {href && (
        <button type="button" onClick={() => navigate(href)} style={{ textDecoration: 'underline' }}>
          {t('card.open')}
        </button>
      )}
    </div>
  );
}

/** Folio's own reading pipeline for a card: read-only, no per-page state (an embedded note's mode). */
const CardMarkdown = memo(function CardMarkdown(props: { markdown: string; space: string; pagePath: string; pageId: string; shareToken?: string; publicSite?: MarkdownPublicSite }) {
  return (
    <Markdown
      markdown={props.markdown}
      space={props.space}
      pagePath={props.pagePath}
      pageId={props.pageId}
      shareToken={props.shareToken}
      shareLinksPageId={props.shareToken ? props.pageId : undefined}
      publicSite={props.publicSite}
      embedded={{ depth: 1, chain: [props.pageId] }}
    />
  );
});
