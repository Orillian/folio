/** JSON Canvas (`.canvas`) support shared by the server and the web app — see parse.ts for the reading rules. */
export * from './parse.js';
export * from './colors.js';
export * from './geometry.js';
export * from './text.js';
export * from './rewrite.js';

/** `notes/Map.canvas` (any case) is a canvas page. */
export function isCanvasPath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith('.canvas');
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', '3gp']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'ogv', 'mkv']);

/** What a file card shows for a file that is not a page, by its extension (Obsidian's own media sets). */
export function canvasFileMedia(relPath: string): 'image' | 'audio' | 'video' | 'other' {
  const dot = relPath.lastIndexOf('.');
  const ext = dot === -1 ? '' : relPath.slice(dot + 1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'other';
}
