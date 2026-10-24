'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, CheckCircle2, Clock3, CreditCard, Image as ImageIcon, Loader2, LogOut, MapPin, Palette, QrCode, Store, Upload, Utensils } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext, type CurrentRestaurantContext } from '@/lib/restaurant-context';
import { removeBrandLogo, uploadBrandLogo, validateLogoImage } from '@/lib/brand-assets';

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
const initialForm: FormState = { restaurant: '', restaurantCategory: 'Restaurant', cuisineType: '', businessEmail: '', address: '', phone: '', branchName: 'Main Branch', timezone: 'Asia/Kolkata', opening: '09:00', closing: '23:00', primary: '#111111', secondary: '#f5f5f5', accent: '#ee7c30', theme: 'minimal', tableCount: '10' };

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(1);
  const [context, setContext] = useState<CurrentRestaurantContext | null>(null);
  const [completed, setCompleted] = useState<number[]>([]);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(initialForm);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tablesCreated, setTablesCreated] = useState<number | null>(null);

  const saveProgress = useCallback(async (nextStep: number, completedStep?: number, complete = false) => {
    const response = await fetch('/api/onboarding/progress', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: nextStep, completedStep, complete }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? 'Could not save onboarding progress. Apply the Build 28 database migration.');
    const steps = Array.isArray(body.progress?.completedSteps) ? body.progress.completedSteps.filter((value: unknown): value is number => Number.isInteger(value)) : [];
    setCompleted(steps);
  }, []);

  const reloadWorkspace = useCallback(async () => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const resolved = await getCurrentRestaurantContext(supabase);
    if (resolved.error || !resolved.data) throw resolved.error ?? new Error('Restaurant workspace could not be loaded.');
    setContext(resolved.data);
    setForm((current) => ({ ...current, restaurant: resolved.data!.organization.name, address: resolved.data!.branch.address ?? '', phone: resolved.data!.branch.phone ?? '', branchName: resolved.data!.branch.name }));
    return resolved.data;
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
      setCompleted(done);
      if (progressBody.completedAt) { router.replace('/dashboard'); return; }
      setStep(Math.max(2, Math.min(7, Number(saved.step ?? 2))));
      setLoading(false);
    }
    void load();
    return () => { active = false; };
  }, [router, supabase]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) { setForm((current) => ({ ...current, [key]: value })); }

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
    try { await saveProgress(5, 4); setStep(5); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save progress.'); }
    finally { setBusy(false); }
  }

  async function openMenuPage(path: string) {
    setBusy(true); setError(null);
    try { await saveProgress(4); router.push(path); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save onboarding progress.'); }
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
    try { await saveProgress(6, 5); setStep(6); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save progress.'); }
    finally { setBusy(false); }
  }

  async function continuePayments() {
    setBusy(true); setError(null);
    try { await saveProgress(7, 6); setStep(7); }
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
        <header className="onboarding-v2-header"><Brand /><button type="button" className="button button-light" onClick={() => void signOut()} disabled={busy}><LogOut size={15} /> Sign out</button></header>
        <div className="onboarding-v2-progress"><div className="onboarding-v2-progress-copy"><span>RESTAURANT SETUP</span><strong>Step {step} of 7</strong></div><div className="onboarding-v2-progress-track"><span style={{ width: `${progressPercent}%` }} /></div></div>
        <div className="onboarding-v2-body">
          <aside className="onboarding-v2-steps">{STEPS.map((item, index) => { const number = index + 1; const isDone = completed.includes(number) || number < step; return <div key={item.title} className={`onboarding-v2-step ${number === step ? 'current' : ''} ${isDone ? 'done' : ''}`}><span className="onboarding-v2-step-icon">{isDone ? <Check size={15} /> : number}</span><span><strong>{item.title}</strong><small>{item.description}</small></span></div>; })}</aside>
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
    <div className="onboarding-v2-icon"><Utensils size={22} /></div><span className="eyebrow">STEP 04 · MENU</span><h1>Bring your menu into TABLELY.</h1><p className="onboarding-v2-lead">Import a PDF, spreadsheet or menu image, review every extracted item, or build the menu manually.</p>
    <div className="onboarding-v2-choice"><div><Upload size={20} /><strong>Import an existing menu</strong><span>PDF, XLSX, CSV or image. Extracted items stay inactive until you activate them.</span><Link className="button button-primary" href="/menu/import?from=onboarding" onClick={(event) => { event.preventDefault(); void openMenuPage('/menu/import?from=onboarding'); }}>Open menu importer <ArrowRight size={15} /></Link></div><div><Utensils size={20} /><strong>Create menu manually</strong><span>Add categories, dishes, prices, modifiers and variants in the existing menu manager.</span><Link className="button button-light" href="/menu?from=onboarding" onClick={(event) => { event.preventDefault(); void openMenuPage('/menu?from=onboarding'); }}>Open menu manager <ArrowRight size={15} /></Link></div></div>
    <div className="onboarding-v2-actions"><button className="button button-light" onClick={() => void continueMenu()} disabled={busy}>Set up menu later</button><button className="button button-primary" onClick={() => void continueMenu()} disabled={busy}>Continue <ArrowRight size={16} /></button></div>
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
    <div className="onboarding-v2-actions"><button className="button button-light" onClick={() => void continuePayments()} disabled={busy}>Configure payments later</button><button className="button button-primary" onClick={() => void continuePayments()} disabled={busy}>Continue <ArrowRight size={16}/></button></div>
  </>);

  return shell(<>
    <div className="onboarding-v2-icon"><CheckCircle2 size={22} /></div><span className="eyebrow">STEP 07 · READY TO LAUNCH</span><h1>Your TABLELY workspace is ready.</h1><p className="onboarding-v2-lead">Review the setup steps below. You can refine everything later from your dashboard.</p>
    <div className="onboarding-v2-review">{STEPS.slice(0, 6).map((item, index) => <div key={item.title}><span><CheckCircle2 size={17}/></span><div><strong>{item.title}</strong><small>{item.description}</small></div><b>{completed.includes(index + 1) ? 'Saved' : 'Skipped / later'}</b></div>)}</div>
    <button className="button button-primary button-full" disabled={busy || completed.length < 6} onClick={() => void launch()}>{busy ? <><Loader2 size={16} className="spin"/> Launching…</> : <>Launch TABLELY <ArrowRight size={16}/></>}</button>
    <p className="onboarding-v2-foot"><Clock3 size={14}/> You can finish menu, QR and payment setup later without losing your progress.</p>
  </>);
}

function ShieldCheckFallback() { return <CreditCard size={20} />; }
