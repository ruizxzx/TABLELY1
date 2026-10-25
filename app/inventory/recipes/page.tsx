'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Clock3, Pencil, Plus, RefreshCw, Trash2, Utensils, X } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { extractErrorMessage } from '@/lib/inventory-errors';
import '../inventory.css';

type Recipe = {
  id: string;
  name: string;
  description: string | null;
  menu_item_id: string | null;
  menu_item_name: string | null;
  output_servings: number;
  output_unit: string;
  is_sub_recipe: boolean;
  is_active: boolean;
  current_version_id: string | null;
  version_number: number | null;
  cost_per_serving_paise: number | null;
  updated_at: string;
};

type Ingredient = { id: string; name: string; base_unit: string };
type MenuItem = { id: string; name: string };
type RecipeLineDraft = { itemId: string; quantity: string; yieldPct: string };
type RecipeVersion = {
  id: string;
  version_number: number;
  effective_from: string;
  change_reason: string | null;
  created_at: string;
};
type VersionLine = {
  id: string;
  item_id: string | null;
  item_name: string | null;
  item_base_unit: string | null;
  sub_recipe_id: string | null;
  sub_recipe_name: string | null;
  qty_per_serving: number;
  unit: string;
  yield_pct: number;
};
type RecipeDetails = {
  recipe: Recipe & { branch_id: string | null };
  versions: RecipeVersion[];
  current_lines: VersionLine[];
};
type CostBreakdown = {
  cost_per_serving_paise?: number;
  total_cost_paise?: number;
  output_servings?: number;
  lines?: Array<{
    line_id: string;
    item_name: string | null;
    qty_per_serving: number;
    unit: string;
    line_cost_paise: number;
  }>;
  error?: string;
};

type RecipeCoverage = {
  total_active_menu_items: number;
  menu_items_with_recipes: number;
  coverage_percentage: number;
  unmapped_menu_items: Array<{ id: string; name: string }>;
};

const formatInr = (paise: number | null | undefined) =>
  paise == null ? '—' : `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function InventoryRecipesPage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [canViewCost, setCanViewCost] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editingRecipeId, setEditingRecipeId] = useState<string | null>(null);
  const [editingRecipeBranchId, setEditingRecipeBranchId] = useState<string | null>(null);
  const [historyRecipe, setHistoryRecipe] = useState<Recipe | null>(null);
  const [historyVersions, setHistoryVersions] = useState<RecipeVersion[]>([]);
  const [historyVersionId, setHistoryVersionId] = useState('');
  const [historyLines, setHistoryLines] = useState<VersionLine[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [costs, setCosts] = useState<Record<string, CostBreakdown>>({});
  const [costLoading, setCostLoading] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<RecipeCoverage | null>(null);
  const [showUnmapped, setShowUnmapped] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    menuItemId: '',
    outputServings: '1',
    outputUnit: 'serving',
  });
  const [lines, setLines] = useState<RecipeLineDraft[]>([{ itemId: '', quantity: '', yieldPct: '100' }]);

  const load = useCallback(async () => {
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const context = await getCurrentRestaurantContext(supabase);
      if (!context.data) throw context.error ?? new Error('Restaurant workspace not found.');
      const branch = context.data.branch;
      setBranchId(branch.id);
      setOrganizationId(context.data.organization.id);
      setBranchName(branch.name);

      const [view, manage, cost, recipeResult, itemResult, menuResult, coverageResult] = await Promise.all([
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_VIEW',
        }),
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_RECIPE_MANAGEMENT',
        }),
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_COST_VIEW',
        }),
        supabase.rpc('inventory_list_recipes', {
          p_branch_id: branch.id,
          p_search: null,
          p_is_sub_recipe: false,
        }),
        supabase.rpc('inventory_list_items', {
          p_branch_id: branch.id,
          p_search: null,
          p_status: 'ALL',
          p_limit: 500,
          p_offset: 0,
        }),
        supabase.from('menu_items')
          .select('id,name')
          .eq('branch_id', branch.id)
          .eq('is_draft', false)
          .order('name'),
        supabase.rpc('inventory_get_recipe_coverage', { p_branch_id: branch.id }).then((r) => r, () => ({ data: null, error: null })),
      ]);
      if (view.error) throw view.error;
      if (manage.error) throw manage.error;
      if (cost.error) throw cost.error;
      if (!view.data) throw new Error('You do not have inventory view permission for this branch.');
      if (recipeResult.error) throw recipeResult.error;
      if (itemResult.error) throw itemResult.error;
      if (menuResult.error) throw menuResult.error;
      setCanManage(Boolean(manage.data));
      setCanViewCost(Boolean(cost.data));
      setRecipes((recipeResult.data ?? []) as Recipe[]);
      setIngredients(((itemResult.data ?? []) as Ingredient[]).map((item) => ({
        id: String(item.id),
        name: String(item.name),
        base_unit: String(item.base_unit),
      })));
      setMenuItems((menuResult.data ?? []) as MenuItem[]);
      const covData = Array.isArray(coverageResult?.data) ? coverageResult.data[0] : (coverageResult?.data as unknown);
      if (covData && typeof covData === 'object') {
        const cd = covData as Record<string, unknown>;
        setCoverage({
          total_active_menu_items: Number(cd.total_active_menu_items ?? 0),
          menu_items_with_recipes: Number(cd.menu_items_with_recipes ?? 0),
          coverage_percentage: Number(cd.coverage_percentage ?? 0),
          unmapped_menu_items: Array.isArray(cd.unmapped_menu_items) ? (cd.unmapped_menu_items as Array<{ id: string; name: string }>) : [],
        });
      }
    } catch (loadError) {
      setError(extractErrorMessage(loadError, 'Could not load recipes.'));
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateLine(index: number, updates: Partial<RecipeLineDraft>) {
    setLines((current) => current.map((line, lineIndex) =>
      lineIndex === index ? { ...line, ...updates } : line,
    ));
  }

  async function saveRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !canManage || !branchId || !organizationId) return;
    const outputServings = Number(form.outputServings);
    const validLines = lines.map((line) => ({
      item_id: line.itemId,
      qty_per_serving: Number(line.quantity),
      unit: ingredients.find((item) => item.id === line.itemId)?.base_unit ?? '',
      yield_pct: Number(line.yieldPct),
    }));
    if (!form.name.trim() || !Number.isFinite(outputServings) || outputServings <= 0
      || validLines.length === 0
      || validLines.some((line) => !line.item_id || !Number.isFinite(line.qty_per_serving)
        || line.qty_per_serving <= 0 || !Number.isFinite(line.yield_pct)
        || line.yield_pct <= 0 || line.yield_pct > 100)) {
      setError('Enter a recipe name, a positive output quantity, and valid ingredient quantities and yields.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await supabase.rpc('inventory_upsert_recipe', {
        p_organization_id: organizationId,
        p_id: editingRecipeId,
        p_menu_item_id: form.menuItemId || null,
        p_branch_id: editingRecipeId ? editingRecipeBranchId : branchId,
        p_name: form.name.trim(),
        p_description: form.description.trim() || null,
        p_output_servings: outputServings,
        p_output_unit: form.outputUnit.trim() || 'serving',
        p_prep_time_minutes: null,
        p_cooking_time_minutes: null,
        p_instructions: null,
        p_is_sub_recipe: false,
        p_is_active: true,
        p_change_reason: editingRecipeId ? 'Updated from inventory recipe builder' : 'Initial recipe',
        p_lines: validLines,
      });
      if (result.error) throw result.error;
      setForm({ name: '', description: '', menuItemId: '', outputServings: '1', outputUnit: 'serving' });
      setLines([{ itemId: '', quantity: '', yieldPct: '100' }]);
      setEditingRecipeId(null);
      setEditingRecipeBranchId(null);
      setShowCreate(false);
      await load();
    } catch (saveError) {
      setError(extractErrorMessage(saveError, 'Could not save recipe.'));
    } finally {
      setSaving(false);
    }
  }

  async function editRecipe(recipeId: string) {
    if (!supabase || !canManage || !branchId) return;
    setError(null);
    try {
      const result = await supabase.rpc('inventory_get_recipe', {
        p_recipe_id: recipeId,
        p_branch_id: branchId,
      });
      if (result.error) throw result.error;
      const details = result.data as RecipeDetails;
      if (details.current_lines.some((line) => line.sub_recipe_id)) {
        throw new Error('This recipe includes sub-recipes. Editing mixed recipe lines is not available in this builder yet.');
      }
      if (details.current_lines.length === 0) {
        throw new Error('This recipe has no ingredient lines and cannot be edited in this builder.');
      }
      setEditingRecipeId(recipeId);
      setEditingRecipeBranchId(details.recipe.branch_id);
      setForm({
        name: details.recipe.name,
        description: details.recipe.description ?? '',
        menuItemId: details.recipe.menu_item_id ?? '',
        outputServings: String(details.recipe.output_servings),
        outputUnit: details.recipe.output_unit,
      });
      setLines(details.current_lines.map((line) => ({
        itemId: line.item_id ?? '',
        quantity: String(line.qty_per_serving),
        yieldPct: String(line.yield_pct),
      })));
      setHistoryRecipe(null);
      setShowCreate(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (editError) {
      setError(extractErrorMessage(editError, 'Could not load recipe for editing.'));
    }
  }

  async function openHistory(recipe: Recipe) {
    if (!supabase || !branchId) return;
    setError(null);
    setHistoryLoading(true);
    setHistoryRecipe(recipe);
    setHistoryLines([]);
    try {
      const result = await supabase.rpc('inventory_get_recipe', {
        p_recipe_id: recipe.id,
        p_branch_id: branchId,
      });
      if (result.error) throw result.error;
      const details = result.data as RecipeDetails;
      setHistoryVersions(details.versions ?? []);
      const currentVersion = details.versions.find((version) => version.id === recipe.current_version_id);
      if (!currentVersion) {
        setHistoryVersionId('');
        return;
      }
      setHistoryVersionId(currentVersion.id);
      const versionResult = await supabase.rpc('inventory_get_recipe_version', {
        p_recipe_id: recipe.id,
        p_branch_id: branchId,
        p_version_id: currentVersion.id,
      });
      if (versionResult.error) throw versionResult.error;
      setHistoryLines((versionResult.data as { lines?: VersionLine[] }).lines ?? []);
    } catch (historyError) {
      setError(extractErrorMessage(historyError, 'Could not load recipe history.'));
      setHistoryRecipe(null);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function selectHistoryVersion(versionId: string) {
    if (!supabase || !historyRecipe || !branchId) return;
    setHistoryVersionId(versionId);
    setHistoryLoading(true);
    setError(null);
    try {
      const result = await supabase.rpc('inventory_get_recipe_version', {
        p_recipe_id: historyRecipe.id,
        p_branch_id: branchId,
        p_version_id: versionId,
      });
      if (result.error) throw result.error;
      setHistoryLines((result.data as { lines?: VersionLine[] }).lines ?? []);
    } catch (versionError) {
      setError(extractErrorMessage(versionError, 'Could not load this recipe version.'));
      setHistoryLines([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadCost(recipeId: string) {
    if (!supabase || !canViewCost || !branchId) return;
    setCostLoading(recipeId);
    setError(null);
    try {
      const result = await supabase.rpc('inventory_calculate_recipe_cost', {
        p_recipe_id: recipeId,
        p_branch_id: branchId,
        p_version_id: null,
      });
      if (result.error) throw result.error;
      const breakdown = result.data as CostBreakdown;
      if (breakdown.error) throw new Error(breakdown.error);
      setCosts((current) => ({ ...current, [recipeId]: breakdown }));
    } catch (costError) {
      setError(extractErrorMessage(costError, 'Could not calculate recipe cost.'));
    } finally {
      setCostLoading(null);
    }
  }

  return (
    <StudioShell>
      <main className="inventory-page">
        <SectionHeader
          eyebrow="OPERATIONS · INVENTORY"
          title="Recipes"
          description={`${branchName || 'Your branch'} · Ingredient quantities and dish cost`}
          action={
            <div className="inventory-actions">
              <Link className="button button-light" href="/inventory">Inventory</Link>
              <button type="button" className="button button-light" onClick={() => void load()} disabled={loading}>
                <RefreshCw size={15} /> Refresh
              </button>
              {canManage && (
                <button type="button" className="button button-primary" onClick={() => {
                  setEditingRecipeId(null);
                  setEditingRecipeBranchId(null);
                  setForm({ name: '', description: '', menuItemId: '', outputServings: '1', outputUnit: 'serving' });
                  setLines([{ itemId: '', quantity: '', yieldPct: '100' }]);
                  setShowCreate((open) => !open);
                }}>
                  <Plus size={15} /> Add recipe
                </button>
              )}
            </div>
          }
        />

        {error && <div className="inventory-error" role="alert">{error}</div>}

        {coverage && (
          <section className="inventory-card">
            <div className="inventory-list-heading">
              <div>
                <span className="inventory-kicker">RECIPE COVERAGE</span>
                <h2>
                  {coverage.coverage_percentage}% menu coverage · {coverage.menu_items_with_recipes} of {coverage.total_active_menu_items} active dishes mapped
                </h2>
              </div>
              {coverage.unmapped_menu_items.length > 0 && (
                <button
                  type="button"
                  className="button button-light"
                  onClick={() => setShowUnmapped((prev) => !prev)}
                >
                  {showUnmapped ? 'Hide unmapped dishes' : `Show ${coverage.unmapped_menu_items.length} unmapped dishes`}
                </button>
              )}
            </div>
            {showUnmapped && coverage.unmapped_menu_items.length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {coverage.unmapped_menu_items.map((item) => (
                  <span
                    key={item.id}
                    style={{ padding: '4px 10px', fontSize: 13, background: '#f1f5f9', borderRadius: 6, color: '#334155' }}
                  >
                    {item.name}
                  </span>
                ))}
              </div>
            )}
          </section>
        )}

        {showCreate && canManage && (
          <section className="inventory-create">
            <div className="inventory-create-heading">
              <div>
                <span className="inventory-kicker">{editingRecipeId ? 'NEW RECIPE VERSION' : 'NEW RECIPE'}</span>
                <h2><Utensils size={18} /> {editingRecipeId ? 'Edit recipe' : 'Dish ingredients'}</h2>
              </div>
              <button type="button" className="button button-light" aria-label="Close recipe form" onClick={() => {
                setShowCreate(false);
                setEditingRecipeId(null);
                setEditingRecipeBranchId(null);
              }}>
                <X size={16} />
              </button>
            </div>
            <form onSubmit={(event) => void saveRecipe(event)}>
              <div className="inventory-form-grid">
                <label>Recipe name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={120} /></label>
                <label>Menu dish
                  <select value={form.menuItemId} onChange={(event) => setForm({ ...form, menuItemId: event.target.value })}>
                    <option value="">Not linked</option>
                    {menuItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <label>Batch output<input type="number" min="0.0001" step="0.0001" value={form.outputServings} onChange={(event) => setForm({ ...form, outputServings: event.target.value })} required /></label>
                <label>Output unit<input value={form.outputUnit} onChange={(event) => setForm({ ...form, outputUnit: event.target.value })} required maxLength={24} /></label>
                <label className="inventory-recipe-description">Description<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={500} /></label>
              </div>
              <div className="inventory-recipe-lines">
                <div className="inventory-create-heading">
                  <div><span className="inventory-kicker">RECIPE LINES</span><h2>Ingredients per serving</h2></div>
                  <button type="button" className="button button-light" onClick={() => setLines((current) => [...current, { itemId: '', quantity: '', yieldPct: '100' }])}>
                    <Plus size={15} /> Add ingredient
                  </button>
                </div>
                {lines.map((line, index) => {
                  const ingredient = ingredients.find((item) => item.id === line.itemId);
                  return (
                    <div className="inventory-recipe-line" key={`line-${index}`}>
                      <label>Ingredient
                        <select value={line.itemId} onChange={(event) => updateLine(index, { itemId: event.target.value })} required>
                          <option value="">Select ingredient</option>
                          {ingredients.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.base_unit}</option>)}
                        </select>
                      </label>
                      <label>Quantity ({ingredient?.base_unit ?? 'unit'})
                        <input type="number" min="0.0001" step="0.0001" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} required />
                      </label>
                      <label>Usable yield %
                        <input type="number" min="0.01" max="100" step="0.01" value={line.yieldPct} onChange={(event) => updateLine(index, { yieldPct: event.target.value })} required />
                      </label>
                      <button type="button" className="button button-light inventory-recipe-remove" aria-label={`Remove ingredient line ${index + 1}`} disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="inventory-form-footer">
                <span>Ingredient cost uses current branch stock costs when available.</span>
                <button type="submit" className="button button-primary" disabled={saving}>{saving ? 'Saving…' : editingRecipeId ? 'Save new version' : 'Save recipe'}</button>
              </div>
            </form>
          </section>
        )}

        <section className="inventory-card">
          <div className="inventory-list-heading">
            <div><span className="inventory-kicker">RECIPE BOOK</span><h2>Dish recipes <span>{recipes.length}</span></h2></div>
          </div>
          <div className="inventory-table-wrap">
            <table className="inventory-table">
              <thead><tr><th>Recipe</th><th>Menu item</th><th>Output</th><th>Version</th>{canViewCost && <th>Cost / serving</th>}<th>Actions</th></tr></thead>
              <tbody>
                {loading ? <tr><td className="inventory-empty" colSpan={canViewCost ? 6 : 5}>Loading recipes…</td></tr>
                  : recipes.length === 0 ? <tr><td className="inventory-empty" colSpan={canViewCost ? 6 : 5}>No dish recipes yet.</td></tr>
                    : recipes.map((recipe) => (
                      <tr key={recipe.id}>
                        <td><strong>{recipe.name}</strong>{recipe.description && <small>{recipe.description}</small>}</td>
                        <td>{recipe.menu_item_name ?? '—'}</td>
                        <td>{Number(recipe.output_servings).toLocaleString('en-IN')} {recipe.output_unit}</td>
                        <td>{recipe.version_number ? `v${recipe.version_number}` : 'Draft'}</td>
                        {canViewCost && (
                          <td>
                            {costs[recipe.id]
                              ? <div className="inventory-recipe-cost">
                                  <strong>{formatInr(costs[recipe.id].cost_per_serving_paise)}</strong>
                                  <small>{costs[recipe.id].lines?.length ?? 0} ingredient lines</small>
                                </div>
                              : <button type="button" className="button button-light" disabled={costLoading === recipe.id} onClick={() => void loadCost(recipe.id)}>
                                  {costLoading === recipe.id ? 'Calculating…' : 'Calculate'}
                                </button>}
                          </td>
                        )}
                        <td><div className="inventory-actions">
                          {canManage && <button type="button" className="button button-light inventory-recipe-action" onClick={() => void editRecipe(recipe.id)} aria-label={`Edit ${recipe.name}`}><Pencil size={14} /> Edit</button>}
                          <button type="button" className="button button-light inventory-recipe-action" onClick={() => void openHistory(recipe)} aria-label={`View ${recipe.name} version history`}><Clock3 size={14} /> History</button>
                        </div></td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          {canViewCost && Object.entries(costs).map(([recipeId, breakdown]) => (
            <details className="inventory-recipe-breakdown" key={recipeId}>
              <summary>{recipes.find((recipe) => recipe.id === recipeId)?.name ?? 'Recipe'} · total batch {formatInr(breakdown.total_cost_paise)}</summary>
              <ul>{breakdown.lines?.map((line) => (
                <li key={line.line_id}>
                  <span>{line.item_name ?? 'Ingredient'} · {Number(line.qty_per_serving).toLocaleString('en-IN')} {line.unit} / serving</span>
                  <strong>{formatInr(line.line_cost_paise)}</strong>
                </li>
              ))}</ul>
            </details>
          ))}
          {!loading && recipes.length === 0 && canManage && ingredients.length === 0 && (
            <p className="inventory-list-footnote">Add ingredients in Inventory before building a recipe.</p>
          )}
        </section>
        {historyRecipe && <section className="inventory-card">
          <div className="inventory-list-heading">
            <div><span className="inventory-kicker">AUDIT HISTORY</span><h2>{historyRecipe.name} versions</h2></div>
            <button type="button" className="button button-light" onClick={() => setHistoryRecipe(null)}>Close history</button>
          </div>
          {historyVersions.length === 0 ? <p className="inventory-list-footnote">No saved versions are available.</p> : <>
            <div className="inventory-filters">
              <label>Version
                <select value={historyVersionId} onChange={(event) => void selectHistoryVersion(event.target.value)}>
                  {historyVersions.map((version) => <option key={version.id} value={version.id}>v{version.version_number} · {new Date(version.created_at).toLocaleString('en-IN')}</option>)}
                </select>
              </label>
              <span className="inventory-list-footnote">{historyVersions.find((version) => version.id === historyVersionId)?.change_reason || 'No change note'}</span>
            </div>
            <div className="inventory-table-wrap"><table className="inventory-table">
              <thead><tr><th>Ingredient</th><th>Quantity per serving</th><th>Yield</th></tr></thead>
              <tbody>{historyLoading ? <tr><td className="inventory-empty" colSpan={3}>Loading version…</td></tr>
                : historyLines.length === 0 ? <tr><td className="inventory-empty" colSpan={3}>This version has no ingredient lines.</td></tr>
                  : historyLines.map((line) => <tr key={line.id}>
                    <td><strong>{line.item_name ?? line.sub_recipe_name ?? 'Unknown ingredient'}</strong></td>
                    <td>{Number(line.qty_per_serving).toLocaleString('en-IN')} {line.unit}</td>
                    <td>{line.yield_pct}%</td>
                  </tr>)}</tbody>
            </table></div>
          </>}
        </section>}
      </main>
    </StudioShell>
  );
}
