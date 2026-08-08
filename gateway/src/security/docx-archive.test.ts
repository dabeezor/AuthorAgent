import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { readDocxXmlEntry } from './docx-archive.js';

function craftedHugeEntryFixture(): Buffer {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from('<w:document/>'));
  const fixture = zip.toBuffer();
  const centralHeader = fixture.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (centralHeader < 0) throw new Error('fixture central header not found');
  fixture.writeUInt32LE(0xffff_ffff, centralHeader + 24);
  return fixture;
}

describe('readDocxXmlEntry', () => {
  it('rejects a tiny crafted archive declaring a 4 GiB entry before extraction', () => {
    const fixture = craftedHugeEntryFixture();
    expect(fixture.length).toBeLessThan(256);

    const zip = new AdmZip(fixture);
    expect(() => readDocxXmlEntry(zip, 'word/document.xml')).toThrow(/exceeds.*limit/);
  });

  it('returns a normal bounded XML entry', () => {
    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.from('<w:document/>'));
    expect(readDocxXmlEntry(zip, 'word/document.xml')?.toString()).toBe('<w:document/>');
  });
});
