import { inflateRawSync, inflateSync } from 'node:zlib';

export type MenuImportDraft = {
  name: string;
  description: string | null;
  category: string;
  price: number | null;
  is_veg: boolean | null;
  confidence: number;
  variants: { name: string; price_delta: number }[];
  modifier_groups: { name: string; description: string | null; is_required: boolean; selection_mode: 'SINGLE' | 'MULTI'; min_select: number; max_select: number; modifiers: { name: string; description: string | null; price_delta: number }[] }[];
  selected: boolean;
  warnings: string[];
};

type MenuImportInput = { name: string; description?: string | null; category?: string | null; price?: number | string | null; is_veg?: boolean | null; confidence?: number; variants?: unknown; modifier_groups?: unknown };

const MAX_ITEMS = 500;
const MAX_TEXT_CHARS = 160_000;
const MAX_MENU_PRICE = 9_999_999_999.99;

function decodeXml(value: string) {
  const decodeCodePoint = (raw: string, radix: number) => {
    const codePoint = parseInt(raw, radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
  };
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_m, n: string) => decodeCodePoint(n, 10)).replace(/&#x([\da-f]+);/gi, (_m, n: string) => decodeCodePoint(n, 16));
}

function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim()); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell.trim()); cell = '';
      if (row.some((v) => v.length)) {
        rows.push(row);
        if (rows.length > MAX_ITEMS + 1) throw new Error(`Menus can contain up to ${MAX_ITEMS} items per import. Split this file into smaller uploads.`);
      }
      row = [];
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some((v) => v.length)) {
    rows.push(row);
    if (rows.length > MAX_ITEMS + 1) throw new Error(`Menus can contain up to ${MAX_ITEMS} items per import. Split this file into smaller uploads.`);
  }
  return rows;
}

function normalizeHeader(value: string) { return value.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 0 && value <= MAX_MENU_PRICE ? Math.round(value * 100) / 100 : null;
  const raw = String(value ?? '').trim().replace(/[₹,$\s]/g, '').replace(/^(rs\.?|inr)/i, '');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_MENU_PRICE ? Math.round(parsed * 100) / 100 : null;
}

function signedNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value) <= MAX_MENU_PRICE ? Math.round(value * 100) / 100 : null;
  const raw = String(value ?? '').trim().replace(/[₹,$\s]/g, '').replace(/^(rs\.?|inr)/i, '');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_MENU_PRICE ? Math.round(parsed * 100) / 100 : null;
}

function mapRows(rows: string[][]): MenuImportDraft[] {
  if (!rows.length) return [];
  const aliases: Record<string, string[]> = {
    name: ['name', 'item', 'itemname', 'dish', 'dishname', 'product', 'productname', 'food'],
    category: ['category', 'section', 'group', 'type'],
    description: ['description', 'details', 'itemdescription'],
    price: ['price', 'amount', 'rate', 'mrp', 'sellingprice'],
    veg: ['veg', 'vegetarian', 'foodtype', 'diet'],
  };
  const headerRow = rows[0].map(normalizeHeader);
  const hasHeader = headerRow.some((h) => aliases.name.includes(h)) && headerRow.some((h) => aliases.price.includes(h));
  const headers = hasHeader ? headerRow : ['name', 'category', 'price', 'description', 'veg'];
  const findIndex = (key: string) => headers.findIndex((header) => aliases[key].includes(header));
  const nameIndex = findIndex('name'); const priceIndex = findIndex('price');
  const categoryIndex = findIndex('category'); const descriptionIndex = findIndex('description'); const vegIndex = findIndex('veg');
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (dataRows.length > MAX_ITEMS) throw new Error(`Menus can contain up to ${MAX_ITEMS} items per import. Split this file into smaller uploads.`);
  return dataRows.map((row) => {
    const name = String(row[nameIndex] ?? '').trim().slice(0, 140);
    const rawPrice = row[priceIndex] ?? '';
    const price = numberValue(rawPrice);
    const category = String(row[categoryIndex] ?? 'Uncategorized').trim().slice(0, 80) || 'Uncategorized';
    const rawVeg = String(row[vegIndex] ?? '').toLowerCase();
    const isVeg = /^(veg|vegetarian|yes|true)$/i.test(rawVeg) ? true : /^(non.?veg|nonvegetarian|no|false)$/i.test(rawVeg) ? false : null;
    const warnings: string[] = [];
    if (!name) warnings.push('Item name is missing.');
    if (price === null) warnings.push('Price is missing or invalid; review before import.');
    return { name, description: String(row[descriptionIndex] ?? '').trim().slice(0, 600) || null, category, price, is_veg: isVeg, confidence: warnings.length ? 0.65 : 0.95, variants: [], modifier_groups: [], selected: Boolean(name), warnings };
  }).filter((item) => item.name);
}

function zipFiles(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The spreadsheet file is not a valid XLSX archive.');
  const entries = buffer.readUInt16LE(eocd + 10);
  if (entries > 2000) throw new Error('This spreadsheet contains too many archive entries.');
  let totalUncompressed = 0;
  let cursor = buffer.readUInt32LE(eocd + 16);
  const result = new Map<string, Buffer>();
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('The spreadsheet archive contains an invalid directory entry.');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('The spreadsheet archive has an invalid file header.');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (uncompressedSize > 12 * 1024 * 1024 || compressedSize > buffer.length || dataStart + compressedSize > buffer.length) {
      throw new Error('This spreadsheet contains an oversized or invalid archive entry.');
    }
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    const uncompressed = method === 0
      ? Buffer.from(data)
      : method === 8 ? inflateRawSync(data, { maxOutputLength: 12 * 1024 * 1024 }) : null;
    if (!uncompressed) throw new Error('This spreadsheet uses an unsupported compression method.');
    if (uncompressed.length !== uncompressedSize) throw new Error('The spreadsheet archive contains an invalid file size.');
    totalUncompressed += uncompressed.length;
    if (totalUncompressed > 48 * 1024 * 1024) throw new Error('This spreadsheet expands beyond the 48 MB safety limit.');
    result.set(name, uncompressed);
  }
  return result;
}

function excelColumnIndex(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? 'A';
  let index = 0;
  for (const char of letters) index = index * 26 + char.charCodeAt(0) - 64;
  return index - 1;
}

function parseXlsx(buffer: Buffer): MenuImportDraft[] {
  const files = zipFiles(buffer);
  const workbookXml = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const relationshipId = workbookXml.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  const relationships = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relationshipTarget = relationshipId
    ? relationships.match(new RegExp(`<Relationship\\b(?=[^>]*\\bId="${relationshipId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")(?=[^>]*\\bTarget="([^"]+)")[^>]*/>`))?.[1]
    : null;
  const normalizedTarget = relationshipTarget?.replace(/^\//, '').startsWith('xl/')
    ? relationshipTarget.replace(/^\//, '')
    : relationshipTarget ? `xl/${relationshipTarget.replace(/^\.\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = files.get(normalizedTarget) ?? files.get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('No readable first worksheet was found in this workbook.');
  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const sharedStrings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join(''));
  const xml = sheet.toString('utf8');
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length > MAX_ITEMS) throw new Error(`Menus can contain up to ${MAX_ITEMS} items per import. Split this file into smaller uploads.`);
    const row: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const ref = attrs.match(/\br="([A-Z]+\d+)"/i)?.[1] ?? '';
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? '';
      const body = cellMatch[2];
      const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const inline = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
      let parsed = value == null ? inline : decodeXml(value);
      if (type === 's' && value != null) parsed = sharedStrings[Number(value)] ?? '';
      if (ref) row[excelColumnIndex(ref)] = parsed;
    }
    if (row.some((value) => Boolean(value))) rows.push(row.map((v) => v ?? ''));
  }
  return mapRows(rows);
}

function decodePdfLiteral(raw: string) {
  return raw.replace(/\\([\\()])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\n').replace(/\\t/g, ' ').replace(/\\b/g, '').replace(/\\f/g, ' ').replace(/\\([0-7]{1,3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

function extractPdfText(buffer: Buffer): string {
  const source = buffer.toString('latin1');
  const chunks: string[] = [];
  let totalChars = 0;
  const appendText = (value: string) => {
    if (totalChars >= MAX_TEXT_CHARS || !value) return;
    const bounded = value.slice(0, MAX_TEXT_CHARS - totalChars);
    chunks.push(bounded);
    totalChars += bounded.length;
  };
  let cursor = 0;
  while ((cursor = source.indexOf('stream', cursor)) !== -1) {
    const dictStart = source.lastIndexOf('<<', cursor);
    const dict = dictStart >= 0 ? source.slice(dictStart, cursor) : '';
    let dataStart = cursor + 6;
    if (source[dataStart] === '\r' && source[dataStart + 1] === '\n') dataStart += 2;
    else if (source[dataStart] === '\n' || source[dataStart] === '\r') dataStart += 1;
    const end = source.indexOf('endstream', dataStart);
    if (end < 0) break;
    let stream = buffer.subarray(dataStart, end);
    while (stream.length && (stream[stream.length - 1] === 10 || stream[stream.length - 1] === 13)) stream = stream.subarray(0, stream.length - 1);
    try {
      if (/\/FlateDecode/.test(dict)) stream = inflateSync(stream, { maxOutputLength: 5 * 1024 * 1024 });
      const content = stream.toString('latin1');
      for (const match of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
        appendText(decodePdfLiteral(match[1]));
        if (totalChars >= MAX_TEXT_CHARS) break;
      }
      if (totalChars < MAX_TEXT_CHARS) {
        for (const arrayMatch of content.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
          for (const match of arrayMatch[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
            appendText(decodePdfLiteral(match[1]));
            if (totalChars >= MAX_TEXT_CHARS) break;
          }
          if (totalChars >= MAX_TEXT_CHARS) break;
        }
      }
    } catch {
      // Unsupported PDF filters are skipped; caller receives a precise parse error if no text remains.
    }
    cursor = end + 9;
    if (totalChars >= MAX_TEXT_CHARS) break;
  }
  return chunks.join('\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
}

function parsePdfText(text: string): MenuImportDraft[] {
  const rows: string[][] = [];
  let currentCategory = 'Uncategorized';
  for (const rawLine of text.split(/[\r\n]+/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line || line.length > 240) continue;
    const match = line.match(/^(.{2,140}?)\s+(?:₹|Rs\.?\s*)?([0-9]{1,6}(?:\.[0-9]{1,2})?)\s*$/i);
    if (match) rows.push([match[1].trim(), currentCategory, match[2], '']);
    else if (line.length <= 60 && !/[₹$0-9]/.test(line)) currentCategory = line;
  }
  if (!rows.length) throw new Error('No selectable menu text was found in this PDF. For scanned menus, upload clear JPG/PNG/WebP images with AI menu extraction enabled, or export the PDF as a searchable PDF.');
  return mapRows([['name', 'category', 'price', 'description'], ...rows]);
}

function coerceAiItems(value: unknown): MenuImportDraft[] {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items) ? (value as { items: unknown[] }).items : [];
  if (!list.length) throw new Error('The menu extraction provider did not return any menu items.');
  return list.slice(0, MAX_ITEMS).map((entry) => {
    const item = entry as MenuImportInput;
    const name = String(item.name ?? '').trim().slice(0, 140);
    const price = numberValue(item.price);
    const category = String(item.category ?? 'Uncategorized').trim().slice(0, 80) || 'Uncategorized';
    const warnings: string[] = [];
    if (!name) warnings.push('Item name is missing.');
    if (price === null) warnings.push('Price is missing or requires review.');
    const variants = Array.isArray(item.variants) ? item.variants.slice(0, 30).flatMap((v) => {
      const variant = v as { name?: unknown; price_delta?: unknown };
      const variantName = String(variant.name ?? '').trim().slice(0, 80);
      const delta = signedNumberValue(variant.price_delta ?? 0);
      return variantName && delta !== null && Math.abs(delta) <= 1_000_000 ? [{ name: variantName, price_delta: delta }] : [];
    }) : [];
    const modifierGroups = Array.isArray(item.modifier_groups) ? item.modifier_groups.slice(0, 20).flatMap((rawGroup) => {
      const group = rawGroup as { name?: unknown; description?: unknown; is_required?: unknown; selection_mode?: unknown; min_select?: unknown; max_select?: unknown; modifiers?: unknown };
      const groupName = String(group.name ?? '').trim().slice(0, 80);
      if (!groupName) return [];
      const selectionMode: 'SINGLE' | 'MULTI' = group.selection_mode === 'SINGLE' ? 'SINGLE' : 'MULTI';
      const isRequired = group.is_required === true;
      const maxSelectRaw = Number(group.max_select ?? (selectionMode === 'SINGLE' ? 1 : 3));
      const maxSelect = selectionMode === 'SINGLE' ? 1 : Math.min(100, Math.max(1, Number.isInteger(maxSelectRaw) ? maxSelectRaw : 3));
      const minSelectRaw = Number(group.min_select ?? (isRequired ? 1 : 0));
      const minSelect = Math.min(maxSelect, Math.max(isRequired ? 1 : 0, Number.isInteger(minSelectRaw) ? minSelectRaw : (isRequired ? 1 : 0)));
      const modifiers = Array.isArray(group.modifiers) ? group.modifiers.slice(0, 30).flatMap((rawModifier) => {
        const modifier = rawModifier as { name?: unknown; description?: unknown; price_delta?: unknown };
        const modifierName = String(modifier.name ?? '').trim().slice(0, 80);
        const delta = signedNumberValue(modifier.price_delta ?? 0);
        return modifierName && delta !== null && Math.abs(delta) <= 1_000_000 ? [{ name: modifierName, description: String(modifier.description ?? '').trim().slice(0, 300) || null, price_delta: delta }] : [];
      }) : [];
      return modifiers.length ? [{ name: groupName, description: String(group.description ?? '').trim().slice(0, 300) || null, is_required: isRequired, selection_mode: selectionMode, min_select: minSelect, max_select: maxSelect, modifiers }] : [];
    }) : [];
    const rawConfidence = Number(item.confidence ?? (warnings.length ? 0.55 : 0.9));
    const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : (warnings.length ? 0.55 : 0.7);
    return {
      name, description: String(item.description ?? '').trim().slice(0, 600) || null,
      category, price, is_veg: typeof item.is_veg === 'boolean' ? item.is_veg : null,
      confidence,
      variants, modifier_groups: modifierGroups, selected: Boolean(name), warnings,
    };
  }).filter((item) => item.name);
}

async function extractLegacyWithAi(content: string | { mimeType: string; base64: string }, mode: 'text' | 'image'): Promise<MenuImportDraft[]> {
  const apiKey = process.env.TABLELY_MENU_AI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('AI extraction is not configured. Set TABLELY_MENU_AI_API_KEY and TABLELY_MENU_AI_MODEL, or use CSV/XLSX/searchable PDF import.');
  const model = process.env.TABLELY_MENU_AI_MODEL?.trim() || 'gpt-6-luna';
  const base = (process.env.TABLELY_MENU_AI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const userContent = mode === 'image'
    ? [
        { type: 'text', text: 'Extract every menu item from this restaurant menu photograph. Return JSON only in the shape {"items":[{"name":"","description":null,"category":"Uncategorized","price":null,"is_veg":null,"confidence":0.0,"variants":[],"modifier_groups":[{"name":"Add-ons","description":null,"is_required":false,"selection_mode":"MULTI","min_select":0,"max_select":3,"modifiers":[{"name":"Extra cheese","description":null,"price_delta":20}]}]}]}. Extract add-ons only when explicitly listed. Never infer missing prices; use null and lower confidence. Do not invent details.' },
        { type: 'image_url', image_url: { url: `data:${(content as { mimeType: string }).mimeType};base64,${(content as { base64: string }).base64}`, detail: 'high' } },
      ]
    : `Extract restaurant menu items from the following text. Return JSON only in the shape {"items":[{"name":"","description":null,"category":"Uncategorized","price":null,"is_veg":null,"confidence":0.0,"variants":[],"modifier_groups":[{"name":"Add-ons","description":null,"is_required":false,"selection_mode":"MULTI","min_select":0,"max_select":3,"modifiers":[{"name":"Extra cheese","description":null,"price_delta":20}]}]}]}. Extract add-ons only when explicitly listed. Never infer missing prices; use null and lower confidence. Do not invent details.\n\n${content}`;
  const modelOptions = model.startsWith('gpt-6-') ? { reasoning_effort: 'none' } : { temperature: 0 };
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, ...modelOptions, messages: [
      { role: 'system', content: 'You are a precise menu data extraction engine. Output valid JSON only. Never invent menu items, prices, categories, variants or descriptions.' },
      { role: 'user', content: userContent },
    ] }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`AI menu extraction provider returned HTTP ${response.status}. Check TABLELY_MENU_AI_API_KEY, model and provider URL.`);
  const data = await response.json() as { choices?: { message?: { content?: string | null } }[] };
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('AI menu extraction provider returned an empty response.');
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); } catch { throw new Error('AI menu extraction returned invalid JSON. Please try another image or CSV import.'); }
  return coerceAiItems(parsed);
}

async function extractWithAi(content: string | { mimeType: string; base64: string }, mode: 'text' | 'image'): Promise<MenuImportDraft[]> {
  if (await hasDatabaseAiRoute()) { const { executeMenuExtraction } = await import('@/lib/ai-management'); return coerceAiItems(await executeMenuExtraction(content, mode)); }
  if (process.env.TABLELY_MENU_AI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()) return extractLegacyWithAi(content, mode);
  throw new Error('AI extraction is not configured. Configure an approved provider in TABLELY Admin → AI Management, or import a CSV/XLSX/searchable PDF.');
}

async function hasDatabaseAiRoute() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) return false;
  const { hasDatabaseMenuExtractionRoute } = await import('@/lib/ai-management');
  return hasDatabaseMenuExtractionRoute();
}

export async function parseMenuFile(fileName: string, mimeType: string, bytes: Buffer): Promise<MenuImportDraft[]> {
  const lower = fileName.toLowerCase();
  let items: MenuImportDraft[];
  if (lower.endsWith('.csv') || mimeType === 'text/csv' || mimeType === 'application/csv') {
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    const delimiter = (text.split(/\r?\n/, 1)[0]?.split(';').length ?? 0) > (text.split(/\r?\n/, 1)[0]?.split(',').length ?? 0) ? ';' : ',';
    items = mapRows(parseDelimited(text, delimiter));
  } else if (lower.endsWith('.xlsx') || mimeType.includes('spreadsheetml')) {
    items = parseXlsx(bytes);
  } else if (lower.endsWith('.xls')) {
    throw new Error('Legacy binary .xls files are not supported by this importer yet. Save the workbook as .xlsx or CSV and upload it again.');
  } else if (lower.endsWith('.pdf') || mimeType === 'application/pdf') {
    const text = extractPdfText(bytes);
    if (!text) throw new Error('No searchable text could be extracted from this PDF. For scanned menus, upload clear JPG/PNG/WebP images with AI extraction enabled.');
    if (await hasDatabaseAiRoute() || process.env.TABLELY_MENU_AI_API_KEY || process.env.OPENAI_API_KEY) items = await extractWithAi(text, 'text');
    else items = parsePdfText(text);
  } else if (mimeType.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(fileName)) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error('Use a JPG, PNG or WebP menu image.');
    items = await extractWithAi({ mimeType, base64: bytes.toString('base64') }, 'image');
  } else {
    throw new Error('Unsupported menu format. Upload PDF, XLSX, CSV, JPG, PNG or WebP.');
  }
  if (!items.length) throw new Error('No menu items were detected. Check the file or use a structured CSV/XLSX template.');
  if (items.length > MAX_ITEMS) return items.slice(0, MAX_ITEMS);
  return items;
}

export function validateMenuImportDrafts(value: unknown): MenuImportDraft[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`Select between 1 and ${MAX_ITEMS} items to import.`);
  return value.map((entry) => {
    const item = entry as Partial<MenuImportDraft>;
    const name = String(item.name ?? '').trim();
    const category = String(item.category ?? 'Uncategorized').trim() || 'Uncategorized';
    const price = numberValue(item.price);
    if (!name || name.length > 140) throw new Error('Every selected item must have a name of 1–140 characters.');
    if (price === null) throw new Error(`Add a valid non-negative price for “${name}” before importing.`);
    const rawConfidence = Number(item.confidence ?? 0.7);
    const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0.7;
    const modifierGroups = Array.isArray(item.modifier_groups) ? item.modifier_groups.slice(0, 20).flatMap((rawGroup) => {
      const group = rawGroup as { name?: unknown; description?: unknown; is_required?: unknown; selection_mode?: unknown; min_select?: unknown; max_select?: unknown; modifiers?: unknown };
      const groupName = String(group.name ?? '').trim().slice(0, 80);
      if (!groupName) return [];
      const selectionMode: 'SINGLE' | 'MULTI' = group.selection_mode === 'SINGLE' ? 'SINGLE' : 'MULTI';
      const isRequired = group.is_required === true;
      const maxRaw = Number(group.max_select ?? (selectionMode === 'SINGLE' ? 1 : 3));
      const maxSelect = selectionMode === 'SINGLE' ? 1 : Math.min(100, Math.max(1, Number.isInteger(maxRaw) ? maxRaw : 3));
      const minRaw = Number(group.min_select ?? (isRequired ? 1 : 0));
      const minSelect = Math.min(maxSelect, Math.max(isRequired ? 1 : 0, Number.isInteger(minRaw) ? minRaw : (isRequired ? 1 : 0)));
      const modifiers = Array.isArray(group.modifiers) ? group.modifiers.slice(0, 30).flatMap((rawModifier) => {
        const modifier = rawModifier as { name?: unknown; description?: unknown; price_delta?: unknown };
        const modifierName = String(modifier.name ?? '').trim().slice(0, 80);
        const delta = signedNumberValue(modifier.price_delta ?? 0);
        return modifierName && delta !== null && Math.abs(delta) <= 1_000_000 ? [{ name: modifierName, description: String(modifier.description ?? '').trim().slice(0, 300) || null, price_delta: delta }] : [];
      }) : [];
      return modifiers.length ? [{ name: groupName, description: String(group.description ?? '').trim().slice(0, 300) || null, is_required: isRequired, selection_mode: selectionMode, min_select: minSelect, max_select: maxSelect, modifiers }] : [];
    }) : [];
    return {
      name, category: category.slice(0, 80), price,
      description: String(item.description ?? '').trim().slice(0, 600) || null,
      is_veg: typeof item.is_veg === 'boolean' ? item.is_veg : null,
      confidence,
      variants: Array.isArray(item.variants) ? item.variants.slice(0, 30).flatMap((entry) => { const variant = entry as { name?: unknown; price_delta?: unknown }; const variantName = String(variant.name ?? '').trim().slice(0, 80); const delta = signedNumberValue(variant.price_delta ?? 0); return variantName && delta !== null && Math.abs(delta) <= 1_000_000 ? [{ name: variantName, price_delta: delta }] : []; }) : [], modifier_groups: modifierGroups, selected: true, warnings: [],
    };
  });
}
