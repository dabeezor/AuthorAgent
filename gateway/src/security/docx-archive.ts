import AdmZip from 'adm-zip';

/** DOCX XML parts are text; a 16 MiB part is already far beyond normal use. */
export const MAX_DOCX_XML_ENTRY_BYTES = 16 * 1024 * 1024;

/** Read one XML part without trusting an archive-controlled allocation size. */
export function readDocxXmlEntry(
  zip: AdmZip,
  entryName: string,
  maxBytes = MAX_DOCX_XML_ENTRY_BYTES,
): Buffer | null {
  const entry = zip.getEntry(entryName);
  if (!entry) return null;

  const declaredSize = entry.header.size;
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maxBytes) {
    throw new Error(`DOCX entry "${entryName}" exceeds the ${maxBytes}-byte limit`);
  }

  const data = entry.getData();
  if (data.length > maxBytes) {
    throw new Error(`DOCX entry "${entryName}" exceeds the ${maxBytes}-byte limit`);
  }
  return data;
}
