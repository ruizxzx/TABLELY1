import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';
import { executeMenuTranslation } from '@/lib/ai-management';

export const runtime = 'nodejs';
export const maxDuration = 60;

const requestSchema = z.object({
  branchId: z.string().uuid(),
  language: z.enum(['hi', 'bn']),
  refreshAll: z.boolean().optional().default(false),
  cursor: z.number().int().nonnegative().optional().default(0),
  refresh: z.array(z.object({
    entity: z.enum(['categories', 'subcategories', 'items', 'variants', 'modifierGroups', 'modifiers']),
    id: z.string().uuid(),
  })).max(40).optional(),
}).refine((value) => !value.refreshAll || !value.refresh?.length);

type TranslationSource = { id: string; name: string; description?: string | null };
type MenuOption = { id?: string; name?: string; description?: string | null; modifiers?: MenuOption[] };
type MenuRow = {
  category_id?: string | null;
  category_name?: string | null;
  subcategory_id?: string | null;
  subcategory_name?: string | null;
  item_id?: string | null;
  item_name?: string | null;
  item_description?: string | null;
  variants?: MenuOption[] | null;
  modifier_groups?: MenuOption[] | null;
};
const entityConfig = {
  categories: { table: 'menu_category_translations', column: 'category_id', descriptions: false },
  subcategories: { table: 'menu_subcategory_translations', column: 'subcategory_id', descriptions: false },
  items: { table: 'menu_item_translations', column: 'menu_item_id', descriptions: true },
  variants: { table: 'menu_variant_translations', column: 'variant_id', descriptions: true },
  modifierGroups: { table: 'modifier_group_translations', column: 'modifier_group_id', descriptions: true },
  modifiers: { table: 'modifier_translations', column: 'modifier_id', descriptions: true },
} as const;
type EntityName = keyof typeof entityConfig;
const entityNames = Object.keys(entityConfig) as EntityName[];

function addSource(map: Map<string, TranslationSource>, id?: string | null, name?: string | null, description?: string | null) {
  if (id && name?.trim()) map.set(id, { id, name: name.trim(), ...(description === undefined ? {} : { description }) });
}

function isTranslationRecord(value: unknown): value is TranslationSource {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.name === 'string'
    && (record.description === undefined || record.description === null || typeof record.description === 'string');
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid menu translation request.' }, { status: 400 });
  const resolved = await resolveServerRestaurantAccess({ branchId: parsed.data.branchId, permission: 'MENU_MANAGEMENT' });
  if ('error' in resolved) return resolved.error;
  const { access } = resolved;

  const [{ data: categories, error: categoryError }, { data: subcategories, error: subcategoryError }, { data: items, error: itemError }, { data: groups, error: groupError }] = await Promise.all([
    access.admin.from('menu_categories').select('id,name').eq('branch_id', access.branchId),
    access.admin.from('menu_subcategories').select('id,name').eq('branch_id', access.branchId),
    access.admin.from('menu_items').select('id,name,description').eq('branch_id', access.branchId),
    access.admin.from('modifier_groups').select('id,name,description').eq('branch_id', access.branchId),
  ]);
  if (categoryError || subcategoryError || itemError || groupError) {
    return NextResponse.json({ error: 'Could not load the branch menu for translation.' }, { status: 503 });
  }

  const itemIds = (items ?? []).map((row) => row.id);
  const groupIds = (groups ?? []).map((row) => row.id);
  const [{ data: variants, error: variantError }, { data: modifiers, error: modifierError }] = await Promise.all([
    itemIds.length ? access.admin.from('menu_item_variants').select('id,name,description,menu_item_id').in('menu_item_id', itemIds) : Promise.resolve({ data: [], error: null }),
    groupIds.length ? access.admin.from('modifiers').select('id,name,description,modifier_group_id').in('modifier_group_id', groupIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (variantError || modifierError) return NextResponse.json({ error: 'Could not load menu options for translation.' }, { status: 503 });

  const { data: languageSettings, error: languageError } = await access.admin.from('restaurant_language_settings')
    .select('default_language').eq('organization_id', access.context.organization.id).maybeSingle();
  if (languageError) return NextResponse.json({ error: 'Could not load the restaurant menu language.' }, { status: 503 });
  const sourceLanguage = languageSettings?.default_language && ['en', 'hi', 'bn'].includes(languageSettings.default_language)
    ? languageSettings.default_language
    : 'en';
  if (sourceLanguage === parsed.data.language) {
    return NextResponse.json({ translated: 0, remaining: 0, sourceLanguage });
  }

  const sources: Record<EntityName, Map<string, TranslationSource>> = {
    categories: new Map(), subcategories: new Map(), items: new Map(), variants: new Map(), modifierGroups: new Map(), modifiers: new Map(),
  };
  for (const row of categories ?? []) addSource(sources.categories, row.id, row.name);
  for (const row of subcategories ?? []) addSource(sources.subcategories, row.id, row.name);
  for (const row of items ?? []) addSource(sources.items, row.id, row.name, row.description);
  for (const row of variants ?? []) addSource(sources.variants, row.id, row.name, row.description);
  for (const row of groups ?? []) addSource(sources.modifierGroups, row.id, row.name, row.description);
  for (const row of modifiers ?? []) addSource(sources.modifiers, row.id, row.name, row.description);

  const refresh = parsed.data.refreshAll ? [] : parsed.data.refresh ?? [];
  for (const target of refresh) {
    const source = sources[target.entity].get(target.id);
    if (!source) return NextResponse.json({ error: 'A menu item selected for translation does not belong to this branch.' }, { status: 403 });
    const config = entityConfig[target.entity];
    const { error } = await access.admin.from(config.table).delete()
      .eq(config.column, target.id).eq('language_code', parsed.data.language);
    if (error) return NextResponse.json({ error: 'Could not refresh the saved menu translation.' }, { status: 503 });
  }

  const allIds = Object.fromEntries(entityNames.map((entity) => [entity, [...sources[entity].keys()]])) as Record<EntityName, string[]>;
  const existingResults = await Promise.all(entityNames.map(async (entity) => {
    const ids = allIds[entity];
    if (!ids.length) return { rows: [] as Record<string, unknown>[], error: null };
    const config = entityConfig[entity];
    const fields = config.descriptions ? `${config.column},name,description` : `${config.column},name`;
    const { data, error } = await access.admin.from(config.table).select(fields).in(config.column, ids).eq('language_code', parsed.data.language);
    return { rows: (data ?? []) as unknown as Record<string, unknown>[], error };
  }));
  if (existingResults.some((result) => result.error)) return NextResponse.json({ error: 'Could not check saved menu translations.' }, { status: 503 });
  const missing: Record<EntityName, TranslationSource[]> = Object.fromEntries(entityNames.map((entity, index) => {
    const config = entityConfig[entity];
    const present = new Set(existingResults[index].rows.map((row) => String(row[config.column])));
    return [entity, [...sources[entity].values()].filter((source) => !present.has(source.id))];
  })) as Record<EntityName, TranslationSource[]>;

  const batches: Record<EntityName, TranslationSource[]> = {
    categories: [], subcategories: [], items: [], variants: [], modifierGroups: [], modifiers: [],
  };
  let missingCount = entityNames.reduce((count, entity) => count + missing[entity].length, 0);
  let totalCount = missingCount;
  let nextCursor: number | undefined;
  if (parsed.data.refreshAll) {
    const allSources = entityNames.flatMap((entity) => [...sources[entity].values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((source) => ({ entity, source })));
    const cursor = parsed.data.cursor;
    if (cursor > allSources.length) {
      return NextResponse.json({ error: 'The menu changed during translation sync. Please start the sync again.' }, { status: 409 });
    }
    const batch = allSources.slice(cursor, cursor + 40);
    for (const record of batch) batches[record.entity].push(record.source);
    totalCount = allSources.length;
    missingCount = Math.max(0, totalCount - cursor);
    nextCursor = cursor + batch.length;
  } else {
    let budget = 40;
    for (const entity of entityNames) {
      batches[entity] = missing[entity].slice(0, budget);
      budget -= batches[entity].length;
      if (!budget) break;
    }
  }
  if (!missingCount) return NextResponse.json({ translated: 0, remaining: 0, sourceLanguage, ...(parsed.data.refreshAll ? { nextCursor: parsed.data.cursor } : {}) });

  let output: unknown;
  try {
    output = await executeMenuTranslation(sourceLanguage, parsed.data.language, batches);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Menu translation is unavailable.' }, { status: 503 });
  }
  if (!output || typeof output !== 'object') return NextResponse.json({ error: 'AI returned an invalid menu translation.' }, { status: 502 });
  const result = output as Record<string, unknown>;
  const translatedByEntity: Record<EntityName, TranslationSource[]> = {
    categories: [], subcategories: [], items: [], variants: [], modifierGroups: [], modifiers: [],
  };
  for (const entity of entityNames) {
    const values = Array.isArray(result[entity]) ? result[entity].filter(isTranslationRecord) : [];
    const allowed = new Set(batches[entity].map((record) => record.id));
    translatedByEntity[entity] = values.filter((record) => allowed.has(record.id) && record.name.trim().length > 0
      && record.name.length <= 200 && (record.description == null || record.description.length <= 1000));
    if (new Set(translatedByEntity[entity].map((record) => record.id)).size !== batches[entity].length
      || translatedByEntity[entity].length !== batches[entity].length) {
      return NextResponse.json({ error: 'AI returned an incomplete translation. This batch was not saved.' }, { status: 502 });
    }
  }

  let translatedCount = 0;
  const now = new Date().toISOString();
  for (const entity of entityNames) {
    const config = entityConfig[entity];
    const rows = translatedByEntity[entity].map((record) => ({
      [config.column]: record.id,
      language_code: parsed.data.language,
      name: record.name.trim(),
      ...(config.descriptions ? { description: record.description?.trim() || null } : {}),
      updated_at: now,
    }));
    if (rows.length) {
      const { error } = await access.admin.from(config.table).upsert(rows, {
        onConflict: `${config.column},language_code`,
        ignoreDuplicates: !parsed.data.refreshAll,
      });
      if (error) return NextResponse.json({ error: 'Could not save generated menu translations.' }, { status: 503 });
      translatedCount += rows.length;
    }
  }
  const remaining = parsed.data.refreshAll
    ? Math.max(0, totalCount - (nextCursor ?? 0))
    : Math.max(0, missingCount - translatedCount);
  return NextResponse.json({
    translated: translatedCount,
    remaining,
    sourceLanguage,
    ...(parsed.data.refreshAll ? { nextCursor } : {}),
  });
}
