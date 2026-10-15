/**
 * Image sizing shared by the PDF and DOCX paths.
 *
 *  - Obsidian's `![[x.png|200]]` / `|200x100` reaches the export as the markdown image `![alt|200](url)` (markdown.ts
 *    rewriteImageEmbeds; Obsidian itself reads the same suffix on a standard image). `splitAltSize` takes it apart.
 *  - `remarkImageSize` turns that into a width/height style for the PDF's `<img>`.
 *  - `probeImage` reads type and pixel size out of the bytes (no image library is a dependency).
 */
import type { Image, Root } from 'mdast';
import { visit } from 'unist-util-visit';

export interface AltSize {
  alt: string;
  width?: number;
  height?: number;
}

const SIZE_SUFFIX_RE = /^(.*?)\|(\d{1,5})(?:x(\d{1,5}))?$/s;

/** `photo|200x100` -> `{ alt: 'photo', width: 200, height: 100 }`; anything without a size suffix is returned as is. */
export function splitAltSize(alt: string | null | undefined): AltSize {
  const text = alt ?? '';
  const m = SIZE_SUFFIX_RE.exec(text);
  if (!m) return { alt: text };
  return { alt: m[1].trim(), width: Number(m[2]), ...(m[3] ? { height: Number(m[3]) } : {}) };
}

/** Remark plugin: strips the `|W` / `|WxH` suffix off every image's alt and keeps it as a width/height style on the rendered `<img>`. */
export function remarkImageSize() {
  return (tree: Root): void => {
    visit(tree, 'image', (node: Image) => {
      const { alt, width, height } = splitAltSize(node.alt);
      if (width === undefined) return;
      node.alt = alt;
      // Inline style, not the width/height attributes: the print stylesheet's `img { height: auto }` would beat the height attribute.
      const style = `width:${width}px;` + (height !== undefined ? `height:${height}px;` : '');
      const data = (node.data ??= {}) as { hProperties?: Record<string, unknown> };
      data.hProperties = { ...data.hProperties, style };
    });
  };
}

export type RasterType = 'png' | 'jpg' | 'gif' | 'bmp' | 'webp';

export interface ImageProbe {
  type: RasterType;
  width: number;
  height: number;
}

/** Detects PNG/JPEG/GIF/BMP/WebP from the magic bytes and reads the pixel size; null when it is none of them or truncated. */
export function probeImage(buf: Buffer): ImageProbe | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { type: 'bmp', width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
  }
  if (buf.length >= 12 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { type: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8 ') return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** Final pixel size for an image: explicit `|W` / `|WxH` wins, a lone width keeps the aspect ratio, then everything is capped at `maxWidth`. */
export function fitImage(
  natural: { width: number; height: number },
  want: { width?: number; height?: number },
  maxWidth: number,
): { width: number; height: number } {
  let { width, height } = natural;
  if (want.width && want.height) {
    width = want.width;
    height = want.height;
  } else if (want.width) {
    width = want.width;
    height = Math.round((natural.height * want.width) / Math.max(1, natural.width));
  } else if (want.height) {
    height = want.height;
    width = Math.round((natural.width * want.height) / Math.max(1, natural.height));
  }
  if (width > maxWidth) {
    height = Math.round((height * maxWidth) / width);
    width = maxWidth;
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}
