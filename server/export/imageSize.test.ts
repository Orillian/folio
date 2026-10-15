import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { fitImage, probeImage, remarkImageSize, splitAltSize } from './imageSize.js';

describe('splitAltSize', () => {
  it('reads |W and |WxH', () => {
    expect(splitAltSize('cat|200')).toEqual({ alt: 'cat', width: 200 });
    expect(splitAltSize('|200x100')).toEqual({ alt: '', width: 200, height: 100 });
    expect(splitAltSize('plain')).toEqual({ alt: 'plain' });
    expect(splitAltSize(undefined)).toEqual({ alt: '' });
  });
});

describe('remarkImageSize (PDF)', () => {
  it('turns the alt suffix into an inline style', async () => {
    const html = String(
      await unified().use(remarkParse).use(remarkImageSize).use(remarkRehype).use(rehypeStringify).process('![a|200x100](x.png) ![b|50](y.png) ![c](z.png)'),
    );
    expect(html).toContain('alt="a" style="width:200px;height:100px;"');
    expect(html).toContain('alt="b" style="width:50px;"');
    expect(html).toContain('<img src="z.png" alt="c">');
  });
});

describe('probeImage', () => {
  it('reads PNG, GIF, BMP, JPEG and WebP headers', () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(30, 16);
    png.writeUInt32BE(20, 20);
    expect(probeImage(png)).toEqual({ type: 'png', width: 30, height: 20 });

    const gif = Buffer.alloc(12);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(7, 6);
    gif.writeUInt16LE(5, 8);
    expect(probeImage(gif)).toEqual({ type: 'gif', width: 7, height: 5 });

    const bmp = Buffer.alloc(30);
    bmp[0] = 0x42;
    bmp[1] = 0x4d;
    bmp.writeInt32LE(11, 18);
    bmp.writeInt32LE(-9, 22);
    expect(probeImage(bmp)).toEqual({ type: 'bmp', width: 11, height: 9 });

    // SOI, APP0 (len 4), SOF0 height 40 width 60
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x28, 0x00, 0x3c, 0x01, 0x01, 0x11, 0x00]);
    expect(probeImage(jpg)).toEqual({ type: 'jpg', width: 60, height: 40 });

    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8X', 12, 'latin1');
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    expect(probeImage(webp)).toEqual({ type: 'webp', width: 100, height: 50 });

    expect(probeImage(Buffer.from('not an image at all, really'))).toBeNull();
  });
});

describe('fitImage', () => {
  it('honours |W keeping the ratio, |WxH exactly, and caps at the page width', () => {
    expect(fitImage({ width: 400, height: 200 }, { width: 100 }, 620)).toEqual({ width: 100, height: 50 });
    expect(fitImage({ width: 400, height: 200 }, { width: 100, height: 100 }, 620)).toEqual({ width: 100, height: 100 });
    expect(fitImage({ width: 1240, height: 620 }, {}, 620)).toEqual({ width: 620, height: 310 });
    expect(fitImage({ width: 400, height: 200 }, { width: 1240 }, 620)).toEqual({ width: 620, height: 310 });
  });
});
