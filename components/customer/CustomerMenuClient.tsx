'use client';

import Link from 'next/link';
import { Search, Plus, Leaf, Flame, Star, Languages, Tag, ArrowRight, ShoppingBag } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CustomerFrame } from './CustomerLayout';
import { cartStorageKey, getPublicMenu, getPublicMenuLanguageSettings, getPublicTableContext, getPublicActiveOffers, type PublicCouponOffer, type PublicMenuItem, type CartItem, readCart, saveCart, saveCouponCode, formatMoney } from '@/lib/customer';

export default function CustomerMenuClient({ restaurantSlug, tableCode }: { restaurantSlug: string; tableCode: string }) {
  const [context, setContext] = useState<Awaited<ReturnType<typeof getPublicTableContext>> | null>(null);
  const [menu, setMenu] = useState<PublicMenuItem[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [language, setLanguage] = useState('en');
  const [languageSettings, setLanguageSettings] = useState({ defaultLanguage: 'en', enabledLanguages: ['en'] });
  const [cart, setCart] = useState<CartItem[]>([]);
  const [offers, setOffers] = useState<PublicCouponOffer[]>([]);
  const [usedOffer, setUsedOffer] = useState('');
  const [translating, setTranslating] = useState(false);
  const [translationMessage, setTranslationMessage] = useState<string | null>(null);
  const promotedItemIds = useMemo(() => new Set(offers.flatMap(offer => offer.eligible_item_ids ?? [])), [offers]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPublicTableContext(tableCode), getPublicMenu(tableCode), getPublicMenuLanguageSettings(tableCode)])
      .then(([table, rows, settings]) => {
        if (cancelled) return;
        if (table.restaurant_slug !== restaurantSlug) throw new Error('This QR does not belong to this restaurant.');
        let savedLanguage = '';
        try { savedLanguage = localStorage.getItem(`tablely:language:${tableCode}`) ?? ''; } catch {}
        const selectedLanguage = ['en', 'hi', 'bn'].includes(savedLanguage) ? savedLanguage : settings.defaultLanguage;
        setLanguageSettings({ ...settings, enabledLanguages: [...new Set([...settings.enabledLanguages, 'en', 'hi', 'bn'])] }); setLanguage(selectedLanguage);
        setContext(table); setMenu(rows); setCart(readCart(tableCode));
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load this table.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [restaurantSlug, tableCode]);

  const categories = useMemo(() => Array.from(new Map(menu.filter(x => x.category_id && x.category_name).map(x => [x.category_id, x])).values()).sort((a,b)=>a.category_sort-b.category_sort), [menu]);
  const items = useMemo(() => menu.filter(row => row.item_id && row.item_name && row.item_price !== null).filter(row => row.item_name!.toLowerCase().includes(query.toLowerCase().trim())).filter(row => category==='all' || row.category_id===category), [menu, query, category]);

  function translationOf(rows:Array<{language_code:string;name:string;description?:string|null}>|null|undefined){const exact=(rows??[]).find(x=>x.language_code.toLowerCase()===language);return exact;}
  function displayName(item: PublicMenuItem) { return translationOf(item.item_translations)?.name||item.item_name||''; }
  function displayCategory(item: PublicMenuItem) { return translationOf(item.category_translations)?.name||item.category_name; }
  function displayDescription(item: PublicMenuItem) { return translationOf(item.item_translations)?.description||item.item_description||'Freshly prepared.'; }
  async function changeLanguage(nextLanguage:string) {
    setLanguage(nextLanguage);
    setTranslationMessage(null);
    try { localStorage.setItem(`tablely:language:${tableCode}`,nextLanguage); } catch {}
    if (nextLanguage === languageSettings.defaultLanguage) return;
    setTranslating(true);
    setTranslationMessage('Loading saved menu translations…');
    try {
      setMenu(await getPublicMenu(tableCode));
      const languageName = nextLanguage === 'hi' ? 'Hindi' : 'Bengali';
      setTranslationMessage(`Showing saved ${languageName} translations. Any entries not yet translated remain in the restaurant’s original language.`);
    } catch (reason) {
      setTranslationMessage(reason instanceof Error ? reason.message : 'Could not load saved menu translations.');
    } finally { setTranslating(false); }
  }
  function addItem(row: PublicMenuItem) {
    if (!row.item_id || !row.item_name || row.item_price === null || !row.is_available) return;
    const next=[...cart]; const existing=next.find(i=>i.menuItemId===row.item_id && !i.variant && !(i.modifiers?.length));
    if(existing) existing.quantity=Math.min(50,existing.quantity+1);
    else next.push({menuItemId:row.item_id,name:row.item_name,price:Number(row.item_price),quantity:1,imageUrl:row.image_url,addons:[]});
    setCart(next); saveCart(tableCode,next);
  }

  useEffect(()=>{
    const onStorage=(event:StorageEvent)=>{
      if(event.storageArea!==window.localStorage || event.key!==cartStorageKey(tableCode)) return;
      setCart(readCart(tableCode));
    };
    const onCartChange=()=>setCart(readCart(tableCode));
    window.addEventListener('storage',onStorage);
    window.addEventListener('tablely-cart-change',onCartChange);
    return()=>{
      window.removeEventListener('storage',onStorage);
      window.removeEventListener('tablely-cart-change',onCartChange);
    };
  },[tableCode]);

  useEffect(()=>{
    if(!context) return;
    let cancelled=false;
    getPublicActiveOffers(tableCode,cart).then(rows=>{if(!cancelled)setOffers(rows)}).catch(()=>{if(!cancelled)setOffers([])});
    return()=>{cancelled=true};
  },[context,tableCode,cart]);

  if(loading)return <main className="customer-page customer-loading">Loading menu…</main>;
  if(error||!context)return <main className="customer-page"><div className="customer-error"><h1>Unable to open menu</h1><p>{error??'Invalid table.'}</p></div></main>;
  return <CustomerFrame restaurantName={context.restaurant_name} tableNumber={context.table_number} tableCode={context.table_code} restaurantSlug={context.restaurant_slug}>
    <div className="customer-content">
      <section className="customer-welcome">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <span className="customer-eyebrow">TABLE {context.table_number}</span>
            <h1>What are you craving?</h1>
            <p>Order directly from your table. No app or account required.</p>
          </div>
          <Link
            href={`/r/${restaurantSlug}/order`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              background: '#ecfdf5',
              color: '#065f46',
              borderRadius: 20,
              border: '1px solid #a7f3d0',
              fontSize: 12,
              fontWeight: 600,
              textDecoration: 'none',
              marginTop: 4
            }}
          >
            <ShoppingBag size={14} color="#059669" />
            <span>Order for Takeaway / Pickup →</span>
          </Link>
        </div>
      </section>
      {offers.length ? <section className="customer-offer-strip" aria-label="Active offers">{offers.map(offer => <div className="customer-offer" key={offer.id}><Tag size={17}/><div><strong>{offer.title}</strong><span>{offer.discount_type==='PERCENTAGE'?`${offer.discount_value}% OFF`:`₹${offer.discount_value} OFF`} · Min {formatMoney(Number(offer.minimum_order_amount))}{offer.code?` · Code ${offer.code}`:''}</span></div><button type="button" className="customer-add" onClick={()=>{saveCouponCode(tableCode,offer.code);setUsedOffer(offer.code);}}>{usedOffer===offer.code?'Applied':'Use offer'}</button></div>)}</section> : null}
      <div className="customer-menu-toolbar">
        <div className="customer-search-wrap"><Search size={17}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search food, drinks…" aria-label="Search menu"/></div>
        {languageSettings.enabledLanguages.length>1?<label className="customer-language-picker"><Languages size={16}/><select value={language} disabled={translating} onChange={e=>void changeLanguage(e.target.value)} aria-label="Language">{languageSettings.enabledLanguages.map(code=><option key={code} value={code}>{code==='hi'?'Hindi':code==='bn'?'Bengali':'English'}</option>)}</select></label>:null}
      </div>
      {translationMessage?<p className="customer-translation-status" role="status" aria-live="polite">{translationMessage}</p>:null}
      <div className="customer-categories" role="tablist" aria-label="Menu categories"><button className={category==='all'?'active':''} onClick={()=>setCategory('all')}>All</button>{categories.map(item=><button className={category===item.category_id?'active':''} key={item.category_id} onClick={()=>setCategory(item.category_id)}>{displayCategory(item)}</button>)}</div>
      <div className="customer-menu-grid">{items.map(item=><article className={`customer-food-card ${item.is_available?'':'unavailable'}`} key={item.item_id}>
        <Link href={`/r/${restaurantSlug}/table/${tableCode}/product/${item.item_id}`} className="customer-food-media">{item.image_url?<img src={item.image_url} alt=""/>:<span>{item.item_name?.slice(0,1)}</span>}{item.is_featured?<em><Star size={11} fill="currentColor"/> Featured</em>:item.is_popular?<em><Star size={11} fill="currentColor"/> Popular</em>:null}{item.item_id&&promotedItemIds.has(item.item_id)?<em><Tag size={11}/> Offer</em>:null}</Link>
        <div className="customer-food-body"><div className="customer-food-top"><div><h2>{displayName(item)}</h2><p>{displayDescription(item)}</p></div><strong>{formatMoney(Number(item.item_price))}</strong></div>
          <div className="customer-food-meta">{item.is_veg?<span><Leaf size={12}/> Veg</span>:<span>Non-veg</span>}{item.is_spicy?<span><Flame size={12}/> Spicy</span>:null}{item.meal_section?<span>{item.meal_section}</span>:null}{item.allergens?.length?<span>Allergen info</span>:null}{item.preparation_minutes?<span>{item.preparation_minutes} min</span>:null}</div>
          {item.variants?.length||item.modifier_groups?.length
            ? <Link className="customer-add" href={`/r/${restaurantSlug}/table/${tableCode}/product/${item.item_id}`}><span>Customize</span><ArrowRight size={15} aria-hidden="true"/></Link>
            : <button className="customer-add" disabled={!item.is_available} onClick={()=>addItem(item)}>{item.is_available?<><Plus size={15} aria-hidden="true"/> <span>Add</span></>:'Sold out'}</button>}
        </div>
      </article>)}</div>
      {items.length===0?<div className="customer-empty">No dishes match your search.</div>:null}
      {cart.length?<div className="customer-floating-cart"><span>{cart.reduce((n,i)=>n+i.quantity,0)} item(s) · {formatMoney(cart.reduce((n,i)=>n+i.price*i.quantity,0))}</span><Link href={`/r/${restaurantSlug}/table/${tableCode}/cart`}>View cart</Link></div>:null}
    </div>
  </CustomerFrame>;
}
