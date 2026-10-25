'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3, CreditCard, Image as ImageIcon, Languages, Loader2, LogOut, MapPin, Palette, Plus, QrCode, Sparkles, Store, Upload, Utensils } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext, type CurrentRestaurantContext } from '@/lib/restaurant-context';
import { removeBrandLogo, uploadBrandLogo, validateLogoImage } from '@/lib/brand-assets';
import { syncMenuTranslations } from '@/lib/menu-translations-client';

const STEPS = [
  { title: 'Restaurant', description: 'Create your restaurant workspace.' },
  { title: 'Branch', description: 'Set the main branch details and business hours.' },
  { title: 'Branding', description: 'Choose a simple brand style.' },
  { title: 'Menu', description: 'Import an existing menu or create one manually.' },
  { title: 'Tables', description: 'Create your dining tables and permanent QR destinations.' },
  { title: 'Payments', description: 'Connect Razorpay or start with counter payments.' },
  { title: 'Launch', description: 'Review your setup and open your workspace.' },
] as const;

type FormState = { restaurant: string; restaurantCategory: string; cuisineType: string; businessEmail: string; address: string; phone: string; branchName: string; timezone: string; opening: string; closing: string; primary: string; secondary: string; accent: string; theme: 'minimal' | 'warm' | 'bold'; tableCount: string };
type MenuImportDraft = { name: string; description: string | null; category: string; price: number | null; is_veg: boolean | null; confidence: number; variants: { name: string; price_delta: number }[]; modifier_groups: { name: string; description: string | null; is_required: boolean; selection_mode: 'SINGLE' | 'MULTI'; min_select: number; max_select: number; modifiers: { name: string; description: string | null; price_delta: number }[] }[]; selected: boolean; warnings: string[] };
const initialForm: FormState = { restaurant: '', restaurantCategory: 'Restaurant', cuisineType: '', businessEmail: '', address: '', phone: '', branchName: 'Main Branch', timezone: 'Asia/Kolkata', opening: '09:00', closing: '23:00', primary: '#111111', secondary: '#f5f5f5', accent: '#ee7c30', theme: 'minimal', tableCount: '10' };

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(1);
  const [context, setContext] = useState<CurrentRestaurantContext | null>(null);
  const [completed, setCompleted] = useState<number[]>([]);
  const [skipped, setSkipped] = useState<number[]>([]);
  const [menuCategories, setMenuCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [menuItems, setMenuItems] = useState<Array<{ id: string; name: string; is_draft: boolean; is_available: boolean }>>([]);
  const [menuItemCount, setMenuItemCount] = useState(0);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuTranslationStatus, setMenuTranslationStatus] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [menuItemName, setMenuItemName] = useState('');
  const [menuItemDescription, setMenuItemDescription] = useState('');
  const [menuItemPrice, setMenuItemPrice] = useState('');
  const [menuItemCategoryId, setMenuItemCategoryId] = useState('');
  const [menuImportFile, setMenuImportFile] = useState<File | null>(null);
  const [menuImportJobId, setMenuImportJobId] = useState<string | null>(null);
  const [menuImportDrafts, setMenuImportDrafts] = useState<MenuImportDraft[]>([]);
  const [menuImportStage, setMenuImportStage] = useState<'upload' | 'preview' | 'complete'>('upload');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(initialForm);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tablesCreated, setTablesCreated] = useState<number | null>(null);

  const saveProgress = useCallback(async (nextStep: number, completedStep?: number, complete = false, skippedStep?: number) => {
    const response = await fetch('/api/onboarding/progress', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: nextStep, completedStep, skippedStep, complete }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? 'Could not save onboarding progress. Apply the Build 28 database migration.');
    const steps = Array.isArray(body.progress?.completedSteps) ? body.progress.completedSteps.filter((value: unknown): value is number => Number.isInteger(value)) : [];
    const skippedSteps = Array.isArray(body.progress?.skippedSteps) ? body.progress.skippedSteps.filter((value: unknown): value is number => Number.isInteger(value)) : [];
    setCompleted(steps);
    setSkipped(skippedSteps);
  }, []);

  const reloadWorkspace = useCallback(async () => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const resolved = await getCurrentRestaurantContext(supabase);
    if (resolved.error || !resolved.data) throw resolved.error ?? new Error('Restaurant workspace could not be loaded.');
    setContext(resolved.data);
    setForm((current) => ({ ...current, restaurant: resolved.data!.organization.name, address: resolved.data!.branch.address ?? '', phone: resolved.data!.branch.phone ?? '', branchName: resolved.data!.branch.name }));
    return resolved.data;
  }, [supabase]);

  const loadMenuSetup = useCallback(async (branchId: string) => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const [categoriesResult, countResult, itemsResult] = await Promise.all([
      supabase.from('menu_categories').select('id,name').eq('branch_id', branchId).order('sort_order').order('name'),
      supabase.from('menu_items').select('id', { count: 'exact', head: true }).eq('branch_id', branchId),
      supabase.from('menu_items').select('id,name,is_draft,is_available').eq('branch_id', branchId).order('created_at', { ascending: false }).limit(5),
    ]);
    const failure = categoriesResult.error ?? countResult.error ?? itemsResult.error;
    if (failure) throw failure;
    const categories = categoriesResult.data ?? [];
    const items = (itemsResult.data ?? []) as Array<{ id: string; name: string; is_draft: boolean; is_available: boolean }>;
    const count = countResult.count ?? 0;
    setMenuCategories(categories);
    setMenuItemCount(count);
    setMenuItems(items);
    setMenuItemCategoryId((current) => categories.some((category) => category.id === current) ? current : categories[0]?.id ?? '');
    return count;
  }, [supabase]);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!supabase) { setError('Supabase is not configured. Add the required environment variables first.'); setLoading(false); return; }
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) { router.replace('/login'); return; }
      const { data: staffRows, error: staffError } = await supabase.from('staff')
        .select('id,role,organization_id').eq('user_id', user.id).eq('active', true).order('created_at', { ascending: true });
      if (!active) return;
      if (staffError) { setError(staffError.message); setLoading(false); return; }
      if (!staffRows?.length) {
        setForm((current) => ({ ...current,
          restaurant: String(user.user_metadata?.restaurant_name ?? ''),
          address: String(user.user_metadata?.restaurant_address ?? ''),
          phone: String(user.user_metadata?.phone ?? ''),
          businessEmail: String(user.email ?? ''),
        }));
        setStep(1);
        setLoading(false);
        return;
      }
      const resolved = await getCurrentRestaurantContext(supabase);
      if (!active) return;
      if (resolved.error || !resolved.data) { setError(resolved.error?.message ?? 'Workspace could not be loaded.'); setLoading(false); return; }
      setContext(resolved.data);
      const { data: restaurantProfile } = await supabase.from('organizations').select('restaurant_category,cuisine_type,business_email').eq('id', resolved.data.organization.id).maybeSingle();
      setForm((current) => ({ ...current, restaurant: resolved.data!.organization.name, restaurantCategory: restaurantProfile?.restaurant_category ?? current.restaurantCategory, cuisineType: restaurantProfile?.cuisine_type ?? current.cuisineType, businessEmail: restaurantProfile?.business_email ?? current.businessEmail, address: resolved.data!.branch.address ?? '', phone: resolved.data!.branch.phone ?? '', branchName: resolved.data!.branch.name }));
      const progressResponse = await fetch('/api/onboarding/progress', { cache: 'no-store' });
      const progressBody = await progressResponse.json().catch(() => ({}));
      if (!progressResponse.ok) {
        setError(progressBody.error ?? 'Build 28 database migration must be applied before onboarding can resume.');
        setLoading(false);
        return;
      }
      const saved = progressBody.progress ?? {};
      const done = Array.isArray(saved.completedSteps) ? saved.completedSteps.filter((value: unknown): value is number => Number.isInteger(value)) : [];
      const skippedSteps = Array.isArray(saved.skippedSteps) ? saved.skippedSteps.filter((value: unknown): value is number => Number.isInteger(value)) : [];
      setCompleted(done);
      setSkipped(skippedSteps);
      if (progressBody.completedAt) { router.replace('/dashboard'); return; }
      setStep(Math.max(2, Math.min(7, Number(saved.step ?? 2))));
      setLoading(false);
    }
    void load();
    return () => { active = false; };
  }, [router, supabase]);

  useEffect(() => {
    if ((step !== 4 && step !== 7) || !context || !supabase) return;
    let active = true;
    setMenuLoading(true);
    void loadMenuSetup(context.branch.id).then(async (count) => {
      if (!active) return;
      if (step === 4 && count > 0 && !completed.includes(4)) {
        await saveProgress(4, 4);
      } else if (step === 4 && count === 0 && completed.includes(4)) {
        await saveProgress(4, undefined, false, 4);
      }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Could not load menu setup.');
    }).finally(() => {
      if (active) setMenuLoading(false);
    });
    return () => { active = false; };
  }, [completed, context, loadMenuSetup, saveProgress, step, supabase]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) { setForm((current) => ({ ...current, [key]: value })); }

  async function addMenuCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !context) return;
    const name = newCategory.trim();
    if (!name) { setError('Enter a category name.'); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const { error: categoryError } = await supabase.rpc('create_menu_category', {
        p_branch_id: context.branch.id,
        p_name: name,
      });
      if (categoryError) throw categoryError;
      setNewCategory('');
      await loadMenuSetup(context.branch.id);
      setNotice(`Category “${name}” added.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add menu category.');
    } finally { setBusy(false); }
  }

  async function addMenuItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !context) return;
    const name = menuItemName.trim();
    const price = Number(menuItemPrice);
    if (!name || !menuItemCategoryId || !Number.isFinite(price) || price < 0 || price > 9_999_999_999.99) {
      setError('Enter an item name, choose a category and provide a valid non-negative price.');
      return;
    }

    setBusy(true); setError(null); setNotice(null);
    try {
      const { error: itemError } = await supabase.from('menu_items').insert({
        branch_id: context.branch.id,
        category_id: menuItemCategoryId,
        name,
        description: menuItemDescription.trim() || null,
        price,
        is_available: true,
        is_draft: false,
        is_veg: null,
        is_spicy: false,
        is_featured: false,
        is_popular: false,
        is_recommended: false,
      });
      if (itemError) throw itemError;
      setMenuItemName('');
      setMenuItemDescription('');
      setMenuItemPrice('');
      await loadMenuSetup(context.branch.id);
      await saveProgress(4, 4);
      setNotice(`“${name}” was added to your menu and saved in onboarding progress.`);
    } catch (reason) {
      let reloadFailure = '';
      try {
        await loadMenuSetup(context.branch.id);
      } catch (reloadReason) {
        reloadFailure = ` Menu status could not be refreshed: ${reloadReason instanceof Error ? reloadReason.message : 'unknown error'}`;
      }
      setError(`The menu item may have been saved, but onboarding could not finish recording it: ${reason instanceof Error ? reason.message : 'unknown error'}.${reloadFailure}`);
    } finally { setBusy(false); }
  }

  async function parseMenuImport() {
    if (!context || !menuImportFile) { setError('Choose a menu photo or file first.'); return; }
    setBusy(true); setError(null); setNotice(null); setMenuImportDrafts([]); setMenuImportJobId(null);
    try {
      const formData = new FormData();
      formData.set('file', menuImportFile);
      formData.set('branchId', context.branch.id);
      const response = await fetch('/api/menu-import/parse', { method: 'POST', body: formData });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not extract the menu.');
      setMenuImportJobId(String(body.jobId));
      setMenuImportDrafts((body.items ?? []) as MenuImportDraft[]);
      setMenuImportStage('preview');
      setNotice(`${body.count ?? 0} menu item(s) extracted. Review names and prices before importing.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Menu extraction failed.');
    } finally { setBusy(false); }
  }

  async function commitMenuImport() {
    if (!context || !menuImportJobId) return;
    const selected = menuImportDrafts.filter((item) => item.selected);
    if (!selected.length) { setError('Select at least one menu item to import.'); return; }
    if (selected.some((item) => !item.name.trim() || item.price === null || !Number.isFinite(Number(item.price)) || Number(item.price) < 0)) {
      setError('Review every selected item name and price before importing.'); return;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/menu-import/commit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: menuImportJobId, branchId: context.branch.id, items: selected }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not import the selected menu items.');
      const count = await loadMenuSetup(context.branch.id);
      if (count > 0) await saveProgress(4, 4);
      setMenuImportStage('complete');
      setNotice(`${body.result?.imported ?? selected.length} item(s) imported as inactive drafts. Review and activate them in Menu when ready.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Menu import failed.');
    } finally { setBusy(false); }
  }

  async function syncOnboardingMenuTranslations() {
    if (!context || menuItemCount === 0) return;
    if (!window.confirm('Regenerate every Hindi and Bengali menu translation now? This will replace existing AI and manually edited translations for this branch.')) return;
    setBusy(true); setError(null); setNotice(null); setMenuTranslationStatus('Syncing all Hindi and Bengali menu translations…');
    try {
      const result = await syncMenuTranslations(context.branch.id, {
        refreshAll: true,
        onProgress: (language, remaining) => setMenuTranslationStatus(
          `Syncing ${language === 'hi' ? 'Hindi' : 'Bengali'} translations…${remaining > 0 ? ` ${remaining} remaining.` : ''}`,
        ),
      });
      setMenuTranslationStatus(`${result.translated} Hindi and Bengali menu translations refreshed and saved.`);
      setNotice('Updated translations are saved with this menu and will be reused for customers.');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not sync menu translations.';
      setMenuTranslationStatus(`Translation sync failed: ${message}`);
      setError(message);
    } finally { setBusy(false); }
  }

  function resetMenuImport() {
    setMenuImportFile(null); setMenuImportJobId(null); setMenuImportDrafts([]); setMenuImportStage('upload');
    setError(null); setNotice(null);
  }

  async function submitRestaurant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (!form.restaurant.trim() || form.restaurant.trim().length < 2 || !form.restaurantCategory.trim() || !form.address.trim()) throw new Error('Restaurant name, category and address are required.');
      const { error: rpcError } = await supabase.rpc('create_restaurant_for_current_user', {
        p_name: form.restaurant.trim(), p_address: form.address.trim(), p_phone: form.phone.trim() || null,
      });
      if (rpcError) throw rpcError;
      await reloadWorkspace();
      // The server binds an unforgeable first-party tracking cookie to the
      // newly created organization; this is a no-op for ordinary signups.
      await fetch('/api/partners/attribution', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }).catch(() => null);
      const profileResponse = await fetch('/api/onboarding/restaurant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: form.restaurantCategory, cuisine: form.cuisineType, email: form.businessEmail }) });
      const profileBody = await profileResponse.json().catch(() => ({}));
      await saveProgress(2, 1);
      setStep(2);
      setNotice(profileResponse.ok ? 'Restaurant workspace created. Continue with your branch setup.' : `Workspace created. Restaurant category details still need saving: ${profileBody.error ?? 'Please retry later.'}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create restaurant workspace.'); }
    finally { setBusy(false); }
  }

  async function saveBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!context) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/onboarding/branch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branchId: context.branch.id, name: form.branchName.trim(), address: form.address.trim(), phone: form.phone.trim(), timezone: form.timezone, businessHours: { monday: { open: form.opening, close: form.closing }, tuesday: { open: form.opening, close: form.closing }, wednesday: { open: form.opening, close: form.closing }, thursday: { open: form.opening, close: form.closing }, friday: { open: form.opening, close: form.closing }, saturday: { open: form.opening, close: form.closing }, sunday: { open: form.opening, close: form.closing } } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not save branch details.');
      const profileResponse = await fetch('/api/onboarding/restaurant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: form.restaurantCategory, cuisine: form.cuisineType, email: form.businessEmail }) });
      const profileBody = await profileResponse.json().catch(() => ({}));
      if (!profileResponse.ok) throw new Error(profileBody.error ?? 'Could not save restaurant category details.');
      await saveProgress(3, 2);
      setStep(3); setNotice('Main branch details saved.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save branch details.'); }
    finally { setBusy(false); }
  }

  async function saveBranding() {
    if (!context || !supabase) return;
    setBusy(true); setError(null); setNotice(null);
    let uploadedPath: string | null = null;
    try {
      const { data: allowed, error: entitlementError } = await supabase.rpc('organization_has_feature', {
        p_organization_id: context.organization.id, p_feature: 'CUSTOM_BRANDING',
      });
      if (entitlementError) throw entitlementError;
      if (allowed !== true) throw new Error('Custom branding is not included in the current plan. Use TABLELY defaults and continue, or upgrade your plan later.');
      const { data: existing, error: existingError } = await supabase.from('organizations')
        .select('brand_logo_url,brand_logo_path').eq('id', context.organization.id).single();
      if (existingError) throw existingError;
      let logoUrl = existing.brand_logo_url ?? null;
      let logoPath = existing.brand_logo_path ?? null;
      if (logoFile) {
        const validation = validateLogoImage(logoFile);
        if (validation) throw new Error(validation);
        const uploaded = await uploadBrandLogo(supabase, context.organization.id, logoFile);
        uploadedPath = uploaded.path;
        logoUrl = uploaded.publicUrl;
        logoPath = uploaded.path;
      }
      const { error: rpcError } = await supabase.rpc('update_build12_branding', {
        p_org_id: context.organization.id, p_logo_url: logoUrl,
        p_primary_color: form.primary, p_secondary_color: form.secondary,
        p_accent_color: form.accent, p_customer_theme: form.theme,
        p_menu_header: null, p_logo_path: logoPath,
      });
      if (rpcError) throw rpcError;
      if (uploadedPath && existing.brand_logo_path) await removeBrandLogo(supabase, existing.brand_logo_path).catch(() => {});
      await saveProgress(4, 3); setStep(4); setNotice('Branding preferences saved.');
    } catch (reason) {
      if (uploadedPath) await removeBrandLogo(supabase, uploadedPath).catch(() => {});
      setError(reason instanceof Error ? reason.message : 'Could not save branding.');
    } finally { setBusy(false); }
  }

  async function continueDefaultBranding() {
    setBusy(true); setError(null);
    try { await saveProgress(4, 3); setStep(4); setNotice('Default TABLELY branding retained. You can customize it later if your plan supports it.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save progress.'); }
    finally { setBusy(false); }
  }

  async function continueMenu() {
    setBusy(true); setError(null);
    try {
      const count = context ? await loadMenuSetup(context.branch.id) : menuItemCount;
      if (count > 0) {
        await saveProgress(5, 4);
        setNotice(`${count} menu item${count === 1 ? '' : 's'} saved. Continue with table setup.`);
      } else {
        await saveProgress(5, undefined, false, 4);
        setNotice('Menu setup marked for later. You can return to this step before launching.');
      }
      setStep(5);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save progress.'); }
    finally { setBusy(false); }
  }

  async function createTables() {
    if (!context) return;
    setBusy(true); setError(null);
    try {
      const count = Number(form.tableCount);
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Enter a table count between 1 and 100.');
      const requestKey = window.sessionStorage.getItem('tablely-onboarding-table-request') ?? crypto.randomUUID();
      window.sessionStorage.setItem('tablely-onboarding-table-request', requestKey);
      const response = await fetch('/api/onboarding/tables', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branchId: context.branch.id, count, requestId: requestKey }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not create tables.');
      const created = Array.isArray(body.result?.table_ids) ? body.result.table_ids.length : count;
      setTablesCreated(created);
      window.sessionStorage.removeItem('tablely-onboarding-table-request');
      await saveProgress(6, 5);
      setStep(6); setNotice(`${created} table(s) are ready with stable QR identifiers.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create tables.'); }
    finally { setBusy(false); }
  }

  async function continueWithoutTables() {
    setBusy(true); setError(null);
    try { await saveProgress(6, undefined, false, 5); setStep(6); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save progress.'); }
    finally { setBusy(false); }
  }

  async function continuePayments(skip = false) {
    setBusy(true); setError(null);
    try {
      if (skip) await saveProgress(7, undefined, false, 6);
      else await saveProgress(7, 6);
      setStep(7);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save progress.'); }
    finally { setBusy(false); }
  }

  async function launch() {
    setBusy(true); setError(null);
    try {
      await saveProgress(7, undefined, true);
      router.replace('/dashboard'); router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not launch workspace.'); }
    finally { setBusy(false); }
  }

  async function goBack() {
    if (step <= 1) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await saveProgress(step - 1);
      setStep((current) => Math.max(1, current - 1));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not go back to the previous setup step.');
    } finally { setBusy(false); }
  }

  async function signOut() {
    if (!supabase) return;
    setBusy(true);
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) { setError(signOutError.message); setBusy(false); return; }
    router.replace('/login'); router.refresh();
  }

  const progressPercent = useMemo(() => Math.round(((step - 1) / 6) * 100), [step]);
  const shell = (content: ReactNode) => (
    <main className="auth-page onboarding-v2-page">
      <section className="onboarding-v2-shell">
        <header className="onboarding-v2-header"><Brand /><div className="button-row">{step > 1 ? <button type="button" className="button button-light" onClick={() => void goBack()} disabled={busy}><ArrowLeft size={15} /> Go back</button> : null}<button type="button" className="button button-light" onClick={() => void signOut()} disabled={busy}><LogOut size={15} /> Sign out</button></div></header>
        <div className="onboarding-v2-progress"><div className="onboarding-v2-progress-copy"><span>RESTAURANT SETUP</span><strong>Step {step} of 7</strong></div><div className="onboarding-v2-progress-track"><span style={{ width: `${progressPercent}%` }} /></div></div>
        <div className="onboarding-v2-body">
          <aside className="onboarding-v2-steps">{STEPS.map((item, index) => { const number = index + 1; const isDone = completed.includes(number); const isSkipped = skipped.includes(number); return <div key={item.title} className={`onboarding-v2-step ${number === step ? 'current' : ''} ${isDone ? 'done' : ''} ${isSkipped ? 'skipped' : ''}`}><span className="onboarding-v2-step-icon">{isDone ? <Check size={15} /> : isSkipped ? '—' : number}</span><span><strong>{item.title}</strong><small>{isSkipped ? 'Skipped · can return before launch' : item.description}</small></span></div>; })}</aside>
          <section className="onboarding-v2-content">
            {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
            {notice ? <div className="notice notice-info" role="status">{notice}</div> : null}
            {content}
          </section>
        </div>
      </section>
    </main>
  );

  if (loading) return <main className="auth-page"><div className="setup-loading"><Loader2 size={22} className="spin" /> Preparing your restaurant setup…</div></main>;
  if (!supabase) return shell(<><h1>Supabase connection required</h1><p>Configure Supabase before creating your restaurant workspace.</p></>);

  if (step === 1) return shell(<>
    <div className="onboarding-v2-icon"><Store size={22} /></div><span className="eyebrow">STEP 01 · WORKSPACE</span><h1>Create your restaurant workspace.</h1><p className="onboarding-v2-lead">Start with the information customers and staff will recognize. You can refine it later.</p>
    <form className="auth-form onboarding-v2-form" onSubmit={submitRestaurant}>
      <label>Restaurant name<input value={form.restaurant} maxLength={120} onChange={(event) => update('restaurant', event.target.value)} placeholder="Spice Route" required /></label>
      <label>Restaurant category<select value={form.restaurantCategory} onChange={(event) => update('restaurantCategory', event.target.value)} required><option value="Restaurant">Restaurant</option><option value="Cafe">Cafe</option><option value="Quick Service Restaurant">Quick Service Restaurant</option><option value="Bakery">Bakery</option><option value="Food Truck">Food Truck</option><option value="Cloud Kitchen">Cloud Kitchen</option><option value="Bar / Pub">Bar / Pub</option><option value="Other">Other</option></select></label>
      <label>Cuisine type<input value={form.cuisineType} maxLength={100} onChange={(event) => update('cuisineType', event.target.value)} placeholder="Bengali, Indian, Italian…" /></label>
      <label>Business email<input type="email" value={form.businessEmail} maxLength={254} onChange={(event) => update('businessEmail', event.target.value)} placeholder="hello@restaurant.com" /></label>
      <label>Restaurant address<textarea value={form.address} maxLength={300} rows={3} onChange={(event) => update('address', event.target.value)} placeholder="Street, city, state" required /></label>
      <label>Contact phone<input value={form.phone} maxLength={30} onChange={(event) => update('phone', event.target.value)} inputMode="tel" placeholder="+91…" /></label>
      <button className="button button-primary button-full" disabled={busy}>{busy ? <><Loader2 size={16} className="spin" /> Creating workspace…</> : <>Create workspace <ArrowRight size={16} /></>}</button>
    </form>
  </>);

  if (step === 2) return shell(<>
    <div className="onboarding-v2-icon"><MapPin size={22} /></div><span className="eyebrow">STEP 02 · MAIN BRANCH</span><h1>Configure your main branch.</h1><p className="onboarding-v2-lead">Set your location, contact and opening hours. You can add other branches later.</p>
    <form className="auth-form onboarding-v2-form" onSubmit={saveBranch}>
      <label>Branch name<input value={form.branchName} maxLength={100} onChange={(event) => update('branchName', event.target.value)} required /></label>
      <label>Address<textarea value={form.address} maxLength={300} rows={3} onChange={(event) => update('address', event.target.value)} required /></label>
      <label>Phone<input value={form.phone} maxLength={30} onChange={(event) => update('phone', event.target.value)} inputMode="tel" /></label>
      <label>Timezone<select value={form.timezone} onChange={(event) => update('timezone', event.target.value)}><option value="Asia/Kolkata">India (Asia/Kolkata)</option><option value="Asia/Dubai">Dubai (Asia/Dubai)</option><option value="Asia/Singapore">Singapore (Asia/Singapore)</option><option value="Europe/London">London (Europe/London)</option><option value="America/New_York">New York (America/New_York)</option><option value="UTC">UTC</option></select></label>
      <div className="two-col-form"><label>Opening time<input type="time" value={form.opening} onChange={(event) => update('opening', event.target.value)} /></label><label>Closing time<input type="time" value={form.closing} onChange={(event) => update('closing', event.target.value)} /></label></div>
      <button className="button button-primary button-full" disabled={busy}>{busy ? 'Saving branch…' : <>Save branch <ArrowRight size={16} /></>}</button>
    </form>
  </>);

  if (step === 3) return shell(<>
    <div className="onboarding-v2-icon"><Palette size={22} /></div><span className="eyebrow">STEP 03 · BRANDING</span><h1>Give your menu a familiar look.</h1><p className="onboarding-v2-lead">Choose colours for customer-facing surfaces. Custom branding may depend on your TABLELY plan.</p>
    <label className="onboarding-v2-field onboarding-logo-upload"><span><ImageIcon size={16}/> Restaurant logo (optional · JPG, PNG, WebP or SVG · max 5 MB)</span><input type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (!file) return; const validation = validateLogoImage(file); if (validation) { setError(validation); event.currentTarget.value = ''; return; } setError(null); setLogoFile(file); const reader = new FileReader(); reader.onload = () => setLogoPreview(typeof reader.result === 'string' ? reader.result : null); reader.readAsDataURL(file); }} /></label>
    {logoPreview ? <div className="onboarding-logo-preview"><img src={logoPreview} alt="Restaurant logo preview"/><span>{logoFile?.name}</span><button type="button" className="button button-light compact" onClick={() => { setLogoFile(null); setLogoPreview(null); }}>Remove</button></div> : null}
    <div className="onboarding-v2-colors"><label>Primary colour<input type="color" value={form.primary} onChange={(event) => update('primary', event.target.value)} /></label><label>Secondary colour<input type="color" value={form.secondary} onChange={(event) => update('secondary', event.target.value)} /></label><label>Accent colour<input type="color" value={form.accent} onChange={(event) => update('accent', event.target.value)} /></label></div>
    <label className="onboarding-v2-field">Menu theme<select value={form.theme} onChange={(event) => update('theme', event.target.value as FormState['theme'])}><option value="minimal">Minimal</option><option value="warm">Warm</option><option value="bold">Bold</option></select></label>
    <div className="onboarding-v2-actions"><button className="button button-light" onClick={() => void continueDefaultBranding()} disabled={busy}>Use TABLELY defaults</button><button className="button button-primary" onClick={() => void saveBranding()} disabled={busy}>{busy ? 'Saving…' : 'Save branding'} <ArrowRight size={16} /></button></div>
  </>);

  if (step === 4) return shell(<>
    <div className="onboarding-v2-icon"><Utensils size={22} /></div><span className="eyebrow">STEP 04 · MENU</span><h1>Build your menu in setup.</h1><p className="onboarding-v2-lead">Add categories and menu items here. Your progress updates as soon as an item is saved, so you can continue setup without leaving this page.</p>
    <div className="notice notice-info" role="status">{menuLoading ? 'Checking your menu…' : `${menuItemCount} menu item${menuItemCount === 1 ? '' : 's'} found${completed.includes(4) && menuItemCount > 0 ? ' · Step saved' : ''}`}</div>
    {menuTranslationStatus ? <div className="notice notice-info" role="status">{menuTranslationStatus}</div> : null}
    {menuItemCount > 0 ? <><button type="button" className="button button-light" disabled={busy || menuLoading} aria-busy={busy && menuTranslationStatus.startsWith('Syncing')} onClick={() => void syncOnboardingMenuTranslations()}>{busy && menuTranslationStatus.startsWith('Syncing') ? <><Loader2 size={15} className="spin" /> Syncing translations…</> : <><Languages size={15} /> Sync Hindi & Bengali translations</>}</button><p className="onboarding-v2-foot">This regenerates the full menu and replaces existing saved Hindi/Bengali translations, including manual edits.</p></> : null}
    <section className="surface-card">
      <div className="onboarding-v2-icon"><Sparkles size={20} /></div>
      <h2>Import with AI</h2>
      <p className="onboarding-v2-lead">Upload a clear menu photo or file. Review the extracted details before they are saved as inactive drafts.</p>
      {menuImportStage === 'upload' ? <>
        <label className="onboarding-v2-field">Menu photo or file (JPG, PNG, WebP, searchable PDF, CSV or XLSX)
          <input type="file" accept=".pdf,.xlsx,.csv,.jpg,.jpeg,.png,.webp,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/jpeg,image/png,image/webp" onChange={(event) => setMenuImportFile(event.target.files?.[0] ?? null)} />
        </label>
        <p className="onboarding-v2-foot">Menu photos use the configured vision model in TABLELY Admin → AI Management. Extracted prices and descriptions must be reviewed; AI will not publish items.</p>
        <button type="button" className="button button-light" disabled={!menuImportFile || busy || menuLoading} onClick={() => void parseMenuImport()}>
          {busy ? <><Loader2 size={15} className="spin" /> Extracting…</> : <><Upload size={15} /> Extract and review</>}
        </button>
      </> : null}
      {menuImportStage === 'preview' ? <>
        <div className="onboarding-v2-menu-drafts">{menuImportDrafts.map((item, index) => <div className="surface-card" key={`${index}-${item.name}`}>
          <label><input type="checkbox" checked={item.selected} onChange={(event) => setMenuImportDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, selected: event.target.checked } : draft))} /> Import this item</label>
          <label>Item name<input value={item.name} maxLength={150} onChange={(event) => setMenuImportDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, name: event.target.value } : draft))} /></label>
          <div className="two-col-form">
            <label>Category<input value={item.category} maxLength={80} onChange={(event) => setMenuImportDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, category: event.target.value } : draft))} /></label>
            <label>Price (₹)<input type="number" min="0" max="9999999999.99" step="0.01" value={item.price ?? ''} onChange={(event) => setMenuImportDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, price: event.target.value === '' ? null : Number(event.target.value) } : draft))} /></label>
          </div>
          <label>Description (optional)<textarea value={item.description ?? ''} maxLength={1000} rows={2} onChange={(event) => setMenuImportDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, description: event.target.value || null } : draft))} /></label>
          {item.warnings.length ? <small>{item.warnings.join(' ')}</small> : null}
        </div>)}</div>
        <div className="onboarding-v2-actions">
          <button type="button" className="button button-light" disabled={busy} onClick={resetMenuImport}>Choose another file</button>
          <button type="button" className="button button-primary" disabled={busy || !menuImportDrafts.some((item) => item.selected)} onClick={() => void commitMenuImport()}>{busy ? <><Loader2 size={15} className="spin" /> Importing…</> : <>Import selected drafts <ArrowRight size={15} /></>}</button>
        </div>
      </> : null}
      {menuImportStage === 'complete' ? <div className="onboarding-v2-actions"><span>Import saved · onboarding progress updated</span><button type="button" className="button button-light" onClick={resetMenuImport}>Import another menu</button></div> : null}
    </section>
    <form className="auth-form onboarding-v2-form" onSubmit={addMenuCategory}>
      <label>Add a category<input value={newCategory} maxLength={80} onChange={(event) => setNewCategory(event.target.value)} placeholder="e.g. Lunch Specials" required /></label>
      <button type="submit" className="button button-light" disabled={busy || menuLoading}><Plus size={15} /> Add category</button>
    </form>
    {menuCategories.length ? <form className="auth-form onboarding-v2-form" onSubmit={addMenuItem}>
      <label>Item name<input value={menuItemName} maxLength={150} onChange={(event) => setMenuItemName(event.target.value)} placeholder="e.g. Paneer tikka" required /></label>
      <label>Description (optional)<textarea value={menuItemDescription} maxLength={1000} rows={2} onChange={(event) => setMenuItemDescription(event.target.value)} placeholder="A short description for your customers" /></label>
      <div className="two-col-form"><label>Category<select value={menuItemCategoryId} onChange={(event) => setMenuItemCategoryId(event.target.value)} required>{menuCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>Price (₹)<input type="number" min="0" max="9999999999.99" step="0.01" value={menuItemPrice} onChange={(event) => setMenuItemPrice(event.target.value)} placeholder="250" required /></label></div>
      <button type="submit" className="button button-primary" disabled={busy || menuLoading}>{busy ? <><Loader2 size={15} className="spin" /> Saving…</> : <><Plus size={15} /> Add menu item</>}</button>
    </form> : <p className="onboarding-v2-lead">Add a category before adding your first item.</p>}
    {menuItems.length ? <section className="surface-card"><h2>Recently added</h2><ul>{menuItems.map((item) => <li key={item.id}>{item.name} · {item.is_draft ? 'Draft' : item.is_available ? 'Available' : 'Unavailable'}</li>)}</ul></section> : null}
    <div className="onboarding-v2-actions"><button className="button button-light" onClick={() => void continueMenu()} disabled={busy || menuLoading}>{menuItemCount > 0 ? 'Continue to tables' : 'Set up menu later'} <ArrowRight size={16} /></button></div>
  </>);

  if (step === 5) return shell(<>
    <div className="onboarding-v2-icon"><QrCode size={22} /></div><span className="eyebrow">STEP 05 · TABLES & QR</span><h1>Set up your dining tables.</h1><p className="onboarding-v2-lead">TABLELY creates permanent QR destinations for new tables. Printed QR cards continue working when restaurant slugs or branding change.</p>
    {tablesCreated !== null ? <div className="notice notice-success">{tablesCreated} tables created successfully. <Link href="/qr?from=onboarding">Open QR cards to preview and print them.</Link></div> : null}
    <label className="onboarding-v2-field">How many tables do you need?<input type="number" min="1" max="100" value={form.tableCount} onChange={(event) => update('tableCount', event.target.value)} /></label>
    <div className="onboarding-v2-actions"><button className="button button-light" onClick={() => void continueWithoutTables()} disabled={busy}>Set up later</button><button className="button button-primary" onClick={() => void createTables()} disabled={busy}>{busy ? <><Loader2 size={15} className="spin"/> Creating…</> : <>Create tables <ArrowRight size={16}/></>}</button></div>
  </>);

  if (step === 6) return shell(<>
    <div className="onboarding-v2-icon"><CreditCard size={22} /></div><span className="eyebrow">STEP 06 · PAYMENTS</span><h1>Choose how customers can pay.</h1><p className="onboarding-v2-lead">You can launch with Pay at Counter and connect Razorpay later. Online payments stay disabled until credentials are verified and configured.</p>
    <div className="onboarding-v2-choice"><div><CreditCard size={20}/><strong>Pay at Counter</strong><span>Continue using cash or UPI collected directly by your restaurant staff.</span><div className="onboarding-v2-status"><CheckCircle2 size={15}/> Available without gateway setup</div></div><div><ShieldCheckFallback/><strong>Razorpay online payments</strong><span>Configure your own merchant credentials, save them encrypted and test the connection.</span><a className="button button-light" href="/settings/payments" target="_blank" rel="noreferrer">Open payment settings <ArrowRight size={15}/></a></div></div>
    <div className="onboarding-v2-actions"><button className="button button-light" onClick={() => void continuePayments(true)} disabled={busy}>Configure payments later</button><button className="button button-primary" onClick={() => void continuePayments()} disabled={busy}>Continue <ArrowRight size={16}/></button></div>
  </>);

  return shell(<>
    <div className="onboarding-v2-icon"><CheckCircle2 size={22} /></div><span className="eyebrow">STEP 07 · READY TO LAUNCH</span><h1>Your TABLELY workspace is ready.</h1><p className="onboarding-v2-lead">Review the setup steps below. You can refine everything later from your dashboard.</p>
    <div className="onboarding-v2-review">{STEPS.slice(0, 6).map((item, index) => { const number = index + 1; const status = completed.includes(number) ? 'Saved' : skipped.includes(number) ? 'Skipped / later' : 'Incomplete'; return <div key={item.title}><span><CheckCircle2 size={17}/></span><div><strong>{item.title}</strong><small>{item.description}</small></div><b>{number === 4 && menuItemCount > 0 ? `Saved · ${menuItemCount} item${menuItemCount === 1 ? '' : 's'}` : status}</b></div>; })}</div>
    <button className="button button-primary button-full" disabled={busy || menuLoading || STEPS.slice(0, 6).some((_, index) => !completed.includes(index + 1) && !skipped.includes(index + 1))} onClick={() => void launch()}>{busy ? <><Loader2 size={16} className="spin"/> Launching…</> : <>Launch TABLELY <ArrowRight size={16}/></>}</button>
    <p className="onboarding-v2-foot"><Clock3 size={14}/> You can finish menu, QR and payment setup later without losing your progress.</p>
  </>);
}

function ShieldCheckFallback() { return <CreditCard size={20} />; }
