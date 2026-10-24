import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMenuFile, validateMenuImportDrafts } from '../lib/menu-import-parser.ts';

test('CSV importer maps menu fields and currency values', async () => {
  const csv = 'Item Name,Category,Description,Price,Food Type\nMasala Dosa,Breakfast,Crispy dosa,120,veg\nChicken Roll,Snacks,Spiced chicken,95,non-veg\n';
  const items = await parseMenuFile('menu.csv', 'text/csv', Buffer.from(csv));
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Masala Dosa');
  assert.equal(items[0].price, 120);
  assert.equal(items[0].is_veg, true);
  assert.equal(items[1].is_veg, false);
});

test('CSV importer detects semicolon-delimited files and missing prices', async () => {
  const csv = 'name;category;price\nCoffee;Beverages;\nTea;Beverages;25\n';
  const items = await parseMenuFile('menu.csv', 'text/csv', Buffer.from(csv));
  assert.equal(items.length, 2);
  assert.equal(items[0].price, null);
  assert.ok(items[0].warnings.some((warning) => warning.includes('Price')));
  assert.equal(items[1].price, 25);
});

test('import validation rejects negative, missing and malformed prices', () => {
  assert.throws(() => validateMenuImportDrafts([{ name: 'Dosa', price: null }]), /valid non-negative price/i);
  assert.throws(() => validateMenuImportDrafts([{ name: 'Dosa', price: -10 }]), /valid non-negative price/i);
  assert.throws(() => validateMenuImportDrafts([{ name: '', price: 10 }]), /must have a name/i);
});

test('import validation preserves bounded variants and normalizes item values', () => {
  const [item] = validateMenuImportDrafts([{ name: 'Paneer Roll', category: 'Snacks', price: '₹125.50', variants: [
    { name: 'Regular', price_delta: 0 }, { name: 'Large', price_delta: 35 }, { name: 'Smaller', price_delta: -2 }, { name: 'Bad', price_delta: 10000000000 },
  ] }]);
  assert.equal(item.price, 125.5);
  assert.deepEqual(item.variants, [{ name: 'Regular', price_delta: 0 }, { name: 'Large', price_delta: 35 }, { name: 'Smaller', price_delta: -2 }]);
  assert.equal(item.selected, true);
});


function makeStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, contentValue] of Object.entries(entries)) {
    const content = Buffer.from(contentValue);
    const filename = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, filename, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + content.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

test('XLSX importer follows the workbook first-sheet relationship', async () => {
  const workbook = '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Menu" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/customMenu.xml"/></Relationships>';
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item Name</t></is></c><c r="B1" t="inlineStr"><is><t>Price</t></is></c><c r="C1" t="inlineStr"><is><t>Category</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Chicken Biryani</t></is></c><c r="B2"><v>210</v></c><c r="C2" t="inlineStr"><is><t>Rice</t></is></c></row></sheetData></worksheet>';
  const file = makeStoredZip({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': rels, 'xl/worksheets/customMenu.xml': sheet });
  const items = await parseMenuFile('menu.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', file);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Chicken Biryani');
  assert.equal(items[0].price, 210);
  assert.equal(items[0].category, 'Rice');
});

test('legacy XLS files fail with a clear conversion instruction', async () => {
  await assert.rejects(() => parseMenuFile('menu.xls', 'application/vnd.ms-excel', Buffer.from('legacy')), /save the workbook as .xlsx or CSV/i);
});

test('unsupported file formats are rejected', async () => {
  await assert.rejects(() => parseMenuFile('menu.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('x')), /unsupported menu format/i);
});


test('CSV importer rejects menus above the 500-item batch limit', async () => {
  const rows = ['name,price', ...Array.from({ length: 501 }, (_, index) => `Dish ${index + 1},10`)];
  await assert.rejects(
    () => parseMenuFile('large.csv', 'text/csv', Buffer.from(rows.join('\n'))),
    /up to 500 items per import/i,
  );
});

test('import validation normalizes non-finite confidence values', () => {
  const [item] = validateMenuImportDrafts([{ name: 'Tea', price: 20, confidence: Number.NaN }]);
  assert.equal(Number.isFinite(item.confidence), true);
  assert.equal(item.confidence, 0.7);
});

test('import validation rejects values outside the menu_items numeric(12,2) range', () => {
  assert.throws(
    () => validateMenuImportDrafts([{ name: 'Luxury Platter', price: 10_000_000_000 }]),
    /valid non-negative price/i,
  );
});


test('import validation preserves explicit add-on groups and bounded modifier adjustments', () => {
  const [item] = validateMenuImportDrafts([{
    name: 'Paneer Wrap', price: 180,
    modifier_groups: [{
      name: 'Add-ons', is_required: false, selection_mode: 'MULTI', min_select: 0, max_select: 3,
      modifiers: [
        { name: 'Extra cheese', price_delta: 25 },
        { name: 'No onion', price_delta: -5 },
        { name: 'Invalid huge adjustment', price_delta: 1000001 },
      ],
    }],
  }]);
  assert.equal(item.modifier_groups.length, 1);
  assert.equal(item.modifier_groups[0].name, 'Add-ons');
  assert.deepEqual(item.modifier_groups[0].modifiers.map((modifier) => modifier.price_delta), [25, -5]);
});


test('AI photo extraction uses the current default model and retains explicit add-ons', async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.TABLELY_MENU_AI_API_KEY;
  const oldModel = process.env.TABLELY_MENU_AI_MODEL;
  const oldBase = process.env.TABLELY_MENU_AI_BASE_URL;
  process.env.TABLELY_MENU_AI_API_KEY = 'test-only-key';
  delete process.env.TABLELY_MENU_AI_MODEL;
  process.env.TABLELY_MENU_AI_BASE_URL = 'https://api.openai.com/v1';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(Object.hasOwn(body, 'temperature'), false);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{
      name: 'Paneer Wrap', category: 'Wraps', price: 180, confidence: .9,
      modifier_groups: [{ name: 'Add-ons', selection_mode: 'MULTI', min_select: 0, max_select: 2, modifiers: [{ name: 'Extra cheese', price_delta: 25 }] }],
    }] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const items = await parseMenuFile('menu.png', 'image/png', Buffer.from('mock-image-bytes'));
    assert.equal(items[0].modifier_groups[0].modifiers[0].name, 'Extra cheese');
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.TABLELY_MENU_AI_API_KEY; else process.env.TABLELY_MENU_AI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.TABLELY_MENU_AI_MODEL; else process.env.TABLELY_MENU_AI_MODEL = oldModel;
    if (oldBase === undefined) delete process.env.TABLELY_MENU_AI_BASE_URL; else process.env.TABLELY_MENU_AI_BASE_URL = oldBase;
  }
});
