/** DOCX images: inline in mixed paragraphs, every embeddable format, |W sizing, visible placeholder. No database needed (storage is mocked). */
import JSZip from 'jszip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-img-'));
vi.mock('../storage.js', () => ({ getSpaceDir: () => dir }));

const { renderDocx } = await import('./docx.js');

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x10, 0, 0x08, 0, 0, 0, 0])]); // 16x8
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x28, 0x00, 0x3c, 0x01, 0x01, 0x11, 0x00]); // 60x40

const BASE = 'https://folio.example.com';
const url = (n: string): string => `${BASE}/files/s/${n}`;
const entry = { space: 's', title: 'T' } as never;

async function docx(markdown: string): Promise<{ xml: string; media: string[] }> {
  const zip = await JSZip.loadAsync(await renderDocx({ markdown, entry, baseUrl: BASE }));
  return {
    xml: await zip.file('word/document.xml')!.async('string'),
    media: Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !n.endsWith('/')),
  };
}

describe('DOCX images', () => {
  beforeAll(() => {
    fs.writeFileSync(path.join(dir, 'a.png'), png(400, 200));
    fs.writeFileSync(path.join(dir, 'b.jpg'), jpg);
    fs.writeFileSync(path.join(dir, 'c.gif'), gif);
    fs.writeFileSync(path.join(dir, 'd.avif'), Buffer.from('not decodable'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('embeds PNG, JPEG and GIF inline next to text', async () => {
    const { xml, media } = await docx(`before ![a](${url('a.png')}) mid ![b](${url('b.jpg')}) and ![c](${url('c.gif')}) after`);
    expect(xml.match(/<w:drawing>/g)).toHaveLength(3);
    expect(media.map((m) => path.extname(m)).sort()).toEqual(['.gif', '.jpg', '.png']);
    expect(xml).toContain('before');
    expect(xml).toContain('after');
  });

  it('honours |W and |WxH and keeps the aspect ratio (EMU = px * 9525)', async () => {
    const one = await docx(`x ![a|100](${url('a.png')})`);
    expect(one.xml).toContain(`cx="${100 * 9525}" cy="${50 * 9525}"`);
    const both = await docx(`x ![a|100x100](${url('a.png')})`);
    expect(both.xml).toContain(`cx="${100 * 9525}" cy="${100 * 9525}"`);
    const wide = await docx(`x ![a|5000](${url('a.png')})`);
    expect(wide.xml).toContain(`cx="${620 * 9525}" cy="${310 * 9525}"`);
  });

  it('prints a visible placeholder for an image it cannot embed, in a mixed or a lone paragraph', async () => {
    const mixed = await docx(`text ![pic](${url('d.avif')}) more`);
    expect(mixed.xml).toContain('[image: pic]');
    expect(mixed.xml).not.toContain('<w:drawing>');
    const remote = await docx('text ![r](https://example.org/x.png) more');
    expect(remote.xml).toContain('[image: r]');
  });
});
