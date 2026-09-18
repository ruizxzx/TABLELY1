'use client';

import { useEffect, useMemo, useState } from 'react';
import { Edit3, Loader2, Plus, Tag, Trash2, X, Eye, EyeOff } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext, type CurrentRestaurantContext } from '@/lib/restaurant-context';

 type Branch={id:string;name:string};
 type Category={id:string;name:string;branch_id:string};
 type Item={id:string;name:string;category_id:string|null;branch_id:string};
 type Coupon={id:string;branch_id:string|null;code:string;title:string|null;description:string|null;offer_type:string;discount_type:string;discount_value:number;minimum_order_amount:number;starts_at:string|null;ends_at:string|null;usage_limit_total:number|null;usage_limit_per_customer:number|null;is_active:boolean;promote:boolean;usage_count:number;updated_at:string};
 type Usage={order_id:string;order_number:number;branch_id:string;table_id:string;customer_phone:string|null;discount_amount:number;applied_at:string};

 const blankForm={id:'',branchId:'',code:'',title:'',description:'',offerType:'STANDARD',discountType:'PERCENTAGE',discountValue:'10',minimum:'0',startsAt:'',endsAt:'',totalLimit:'',customerLimit:'',active:true,promote:false,categoryIds:[] as string[],itemIds:[] as string[]};

 function localInput(value:string|null){if(!value)return '';const d=new Date(value);if(Number.isNaN(d.getTime()))return '';const pad=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;}
 function isoOrNull(value:string){return value?new Date(value).toISOString():null;}

 export default function CouponsPage(){
   const s=getSupabaseBrowserClient();
   const [ctx,setCtx]=useState<CurrentRestaurantContext|null>(null);
   // Whether the signed-in caller may use this page at all: true owner, or
   // a Manager explicitly granted DISCOUNTS_COUPONS. Server RPCs are the
   // real authority -- this only decides what the UI shows, never bypasses
   // the database check.
   const [allowed,setAllowed]=useState(false);
   const [isOwner,setIsOwner]=useState(false);
   // The branch a Manager is locked to (their own branch only). Null for an
   // owner, who may pick any branch or all-branch.
   const [lockedBranchId,setLockedBranchId]=useState<string|null>(null);
   const [branches,setBranches]=useState<Branch[]>([]);
   const [categories,setCategories]=useState<Category[]>([]);
   const [items,setItems]=useState<Item[]>([]);
   const [rows,setRows]=useState<Coupon[]>([]);
   const [form,setForm]=useState(blankForm);
   const [configTarget,setConfigTarget]=useState<{categoryIds:string[];itemIds:string[]}>({categoryIds:[],itemIds:[]});
   const [usage,setUsage]=useState<Usage[]>([]);
   const [usageTarget,setUsageTarget]=useState<string|null>(null);
   const [show,setShow]=useState(false);
   const [busy,setBusy]=useState(false);
   const [loading,setLoading]=useState(true);
   const [error,setError]=useState<string|null>(null);

   async function load(){
     if(!s){setError('Supabase is not configured.');setLoading(false);return;}
     const r=await getCurrentRestaurantContext(s);
     if(!r.data){setError(r.error?.message??'Workspace not found.');setLoading(false);return;}
     setCtx(r.data);

     const owner=r.data.staff.role==='OWNER';
     let manager=false;
     if(!owner && r.data.staff.role==='MANAGER'){
       const{data:permitted}=await s.rpc('has_staff_permission',{p_staff_id:r.data.staff.id,p_permission:'DISCOUNTS_COUPONS'});
       manager=Boolean(permitted);
     }
     if(!owner && !manager){
       setAllowed(false);setLoading(false);
       setError(r.data.staff.role==='MANAGER'?'You do not have access to discounts and coupons. Ask the owner to grant it in Advanced Permissions.':'Owner access is required to manage coupons.');
       return;
     }
     setAllowed(true);setIsOwner(owner);
     // A Manager is always locked to the branch already resolved in their
     // restaurant context -- never a client-editable value, and never sent
     // as an "All Branches" option.
     setLockedBranchId(owner?null:r.data.branch.id);

     const org=r.data.organization.id;
     // Only query branch-dependent data once we have a real organization id
     // and, for a Manager, a real resolved branch id -- never before either
     // has loaded.
     const branchFilterForList:string|null = owner ? null : r.data.branch.id;
     const [{data:bs,error:be},{data:cs,error:ce},{data:is,error:ie},{data:cr,error:cre}]=await Promise.all([
       s.from('branches').select('id,name').eq('organization_id',org).eq('is_active',true).order('name'),
       s.from('menu_categories').select('id,name,branch_id').order('name').limit(500),
       s.from('menu_items').select('id,name,category_id,branch_id').eq('is_available',true).order('name').limit(1000),
       s.rpc('list_coupons_v18',{p_branch_id:branchFilterForList}),
     ]);
     if(be||ce||ie||cre){setError((be||ce||ie||cre)?.message??'Could not load coupons.');setLoading(false);return;}
     setBranches((bs??[]) as Branch[]);setCategories((cs??[]) as Category[]);setItems((is??[]).map(x=>({...x}) as Item));setRows((cr??[]) as Coupon[]);setLoading(false);setError(null);
   }
   useEffect(()=>{void load();},[]);

   const currentBranchItems=useMemo(()=>form.branchId?items.filter(x=>x.branch_id===form.branchId):[],[form.branchId,items]);
   const currentBranchCategories=useMemo(()=>form.branchId?categories.filter(x=>x.branch_id===form.branchId):[],[form.branchId,categories]);

   function openNew(){
     // Owner: default to the branch they are currently viewing (never
     // silently "All Branches"). Manager: always their locked branch, and
     // the selector below is disabled so it can never change.
     const defaultBranch=isOwner?(ctx?.branch.id??''):(lockedBranchId??'');
     setForm({...blankForm,branchId:defaultBranch});setConfigTarget({categoryIds:[],itemIds:[]});setUsageTarget(null);setUsage([]);setShow(true);setError(null);
   }
   async function openEdit(row:Coupon){
     if(!s)return;
     setBusy(true);setError(null);
     const {data,error:e}=await s.rpc('get_coupon_config_v18',{p_id:row.id});
     setBusy(false);
     if(e){setError(e.message);return;}
     const c=Array.isArray(data)?data[0]:data;
     setConfigTarget({categoryIds:Array.isArray(c?.category_ids)?c.category_ids:[],itemIds:Array.isArray(c?.menu_item_ids)?c.menu_item_ids:[]});
     setForm({id:row.id,branchId:row.branch_id??'',code:row.code,title:row.title??'',description:row.description??'',offerType:row.offer_type,discountType:row.discount_type,discountValue:String(row.discount_value),minimum:String(row.minimum_order_amount),startsAt:localInput(row.starts_at),endsAt:localInput(row.ends_at),totalLimit:row.usage_limit_total===null?'':String(row.usage_limit_total),customerLimit:row.usage_limit_per_customer===null?'':String(row.usage_limit_per_customer),active:row.is_active,promote:row.promote,categoryIds:Array.isArray(c?.category_ids)?c.category_ids:[],itemIds:Array.isArray(c?.menu_item_ids)?c.menu_item_ids:[]});setUsageTarget(null);setUsage([]);setShow(true);
   }

   async function save(){
     if(!s)return;
     setBusy(true);setError(null);
     try{
       // A Manager's branch is always forced to their locked branch here too
       // -- belt-and-braces alongside the disabled selector and the
       // server-side enforcement in upsert_coupon_v18, so a manipulated
       // request body still can't move a coupon off the manager's branch.
       const branchId=isOwner?(form.branchId||null):lockedBranchId;
       const payload={
         p_id:form.id||null,p_branch_id:branchId,p_code:form.code,p_title:form.title||null,p_description:form.description||null,p_offer_type:form.offerType,p_discount_type:form.discountType,
         p_discount_value:Number(form.discountValue),p_minimum_order_amount:Number(form.minimum),p_starts_at:isoOrNull(form.startsAt),p_ends_at:isoOrNull(form.endsAt),
         p_usage_limit_total:form.totalLimit?Number(form.totalLimit):null,p_usage_limit_per_customer:form.customerLimit?Number(form.customerLimit):null,p_is_active:form.active,p_promote:form.promote,
         p_category_ids:branchId?form.categoryIds:[],p_menu_item_ids:branchId?form.itemIds:[]
       };
       const {error:e}=await s.rpc('upsert_coupon_v18',payload);if(e)throw e;
       setShow(false);await load();
     }catch(e:unknown){setError(e instanceof Error?e.message:'Could not save coupon.');}finally{setBusy(false);}
   }

   async function toggle(row:Coupon){
     if(!s)return;setBusy(true);setError(null);
     try{
       const {data:cfg,error:ce}=await s.rpc('get_coupon_config_v18',{p_id:row.id}); if(ce)throw ce;
       const c=Array.isArray(cfg)?cfg[0]:cfg;
       const {error:e}=await s.rpc('upsert_coupon_v18',{p_id:row.id,p_branch_id:row.branch_id,p_code:row.code,p_title:row.title,p_description:row.description,p_offer_type:row.offer_type,p_discount_type:row.discount_type,p_discount_value:Number(row.discount_value),p_minimum_order_amount:Number(row.minimum_order_amount),p_starts_at:row.starts_at,p_ends_at:row.ends_at,p_usage_limit_total:row.usage_limit_total,p_usage_limit_per_customer:row.usage_limit_per_customer,p_is_active:!row.is_active,p_promote:row.promote,p_category_ids:Array.isArray(c?.category_ids)?c.category_ids:[],p_menu_item_ids:Array.isArray(c?.menu_item_ids)?c.menu_item_ids:[]});
       if(e)throw e; await load();
     }catch(e:unknown){setError(e instanceof Error?e.message:'Could not update coupon.');}
     finally{setBusy(false)}
   }

   async function viewUsage(id:string){
     if(!s)return;setUsageTarget(id);setBusy(true);setError(null);const {data,error:e}=await s.rpc('list_coupon_usage_v18',{p_coupon_id:id});if(e)setError(e.message);else setUsage((data??[]) as Usage[]);setBusy(false);
   }

   function updateArray(key:'categoryIds'|'itemIds',id:string,checked:boolean){setForm(prev=>({...prev,[key]:checked?Array.from(new Set([...prev[key],id])):prev[key].filter(x=>x!==id)}));}

   if(loading)return <StudioShell><main className="customer-loading">Loading coupons…</main></StudioShell>;
   if(!allowed)return <StudioShell><SectionHeader eyebrow="MARKETING" title="Coupons & offers" description="Owner or delegated branch-manager access required."/>{error?<div className="notice notice-error">{error}</div>:null}</StudioShell>;

   const lockedBranchName=lockedBranchId?(branches.find(b=>b.id===lockedBranchId)?.name??ctx?.branch.name??'your branch'):null;

   return <StudioShell>
     <SectionHeader eyebrow="DISCOUNTS / OFFERS" title="Coupons & offers" description={isOwner?'Create server-validated discounts and promote active offers to customers.':`Branch-scoped discounts for ${lockedBranchName}.`} action={<button className="button button-primary" onClick={openNew}><Plus size={15}/> New coupon</button>}/>
     {!isOwner?<div className="notice notice-info">You can only manage coupons for {lockedBranchName}. Ask the owner for access to other branches.</div>:null}
     {error?<div className="notice notice-error" role="alert">{error}</div>:null}
     <section className="coupon-grid">
       {rows.map(row=><article className="surface-card coupon-card" key={row.id}>
         <div className="coupon-card-head"><div><span className="eyebrow">{row.offer_type.replace('_',' ')}</span><h3>{row.code}</h3><p>{row.title||'Untitled offer'}</p></div><span className={`coupon-state ${row.is_active?'active':'inactive'}`}>{row.is_active?'ACTIVE':'INACTIVE'}</span></div>
         <div className="coupon-main"><strong>{row.discount_type==='PERCENTAGE'?`${row.discount_value}% OFF`:`₹${row.discount_value} OFF`}</strong><span>Min ₹{row.minimum_order_amount} · {row.usage_count} uses{row.usage_limit_total?` / ${row.usage_limit_total}`:''}</span></div>
         <div className="coupon-meta">{row.branch_id?(branches.find(b=>b.id===row.branch_id)?.name||'Branch'):'All branches'}{row.promote?' · Promoted':''}{row.ends_at?` · Ends ${new Date(row.ends_at).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})}`:''}</div>
         <div className="coupon-actions"><button className="button button-light compact" onClick={()=>void openEdit(row)} disabled={busy}><Edit3 size={14}/> Edit</button><button className="button button-light compact" onClick={()=>void toggle(row)} disabled={busy}>{row.is_active?<EyeOff size={14}/>:<Eye size={14}/>} {row.is_active?'Disable':'Enable'}</button><button className="button button-light compact" onClick={()=>void viewUsage(row.id)} disabled={busy}><Tag size={14}/> Usage</button></div>
       </article>)}
       {rows.length===0?<div className="empty-wide">No coupons yet. Create your first offer.</div>:null}
     </section>

     {usageTarget?<div className="modal-backdrop"><div className="modal-card"><div className="modal-head"><div><span className="eyebrow">USAGE</span><h2>{rows.find(x=>x.id===usageTarget)?.code||'Coupon'}</h2></div><button className="icon-button" onClick={()=>setUsageTarget(null)}><X size={17}/></button></div>{usage.length===0?<div className="empty-wide">No usage recorded yet.</div>:<div className="coupon-usage-list">{usage.map(x=><div className="coupon-usage-row" key={`${x.order_id}-${x.applied_at}`}><div><strong>#{x.order_number}</strong><small>{new Date(x.applied_at).toLocaleString('en-IN')}</small></div><span>₹{Number(x.discount_amount).toFixed(2)} · {x.customer_phone||'Anonymous'}</span></div>)}</div>}</div></div>:null}

     {show?<div className="modal-backdrop"><div className="modal-card"><div className="modal-head"><div><span className="eyebrow">COUPON</span><h2>{form.id?'Edit coupon':'Create coupon'}</h2></div><button className="icon-button" onClick={()=>setShow(false)}><X size={17}/></button></div><div className="modal-form">
       <div className="two-col-form"><label>Code<input value={form.code} onChange={e=>setForm({...form,code:e.target.value.toUpperCase()})} maxLength={64} placeholder="SAVE10" required/></label><label>Offer type<select value={form.offerType} onChange={e=>setForm({...form,offerType:e.target.value})}><option value="STANDARD">Standard</option><option value="TIME_BASED">Time based</option><option value="RUSH_HOUR">Rush hour</option><option value="SPECIAL_OFFER">Special offer</option></select></label></div>
       <div className="two-col-form"><label>Title<input value={form.title} onChange={e=>setForm({...form,title:e.target.value})} maxLength={120} placeholder="Lunch special"/></label><label>Minimum order<input type="number" min="0" step="0.01" value={form.minimum} onChange={e=>setForm({...form,minimum:e.target.value})}/></label></div>
       <label>Description<textarea rows={2} value={form.description} onChange={e=>setForm({...form,description:e.target.value})} maxLength={500}/></label>
       <div className="two-col-form"><label>Discount type<select value={form.discountType} onChange={e=>setForm({...form,discountType:e.target.value})}><option value="PERCENTAGE">Percentage</option><option value="FIXED">Fixed amount</option></select></label><label>Discount value<input type="number" min="0" step="0.01" value={form.discountValue} onChange={e=>setForm({...form,discountValue:e.target.value})}/></label></div>
       <div className="two-col-form"><label>Starts<input type="datetime-local" value={form.startsAt} onChange={e=>setForm({...form,startsAt:e.target.value})}/></label><label>Ends<input type="datetime-local" value={form.endsAt} onChange={e=>setForm({...form,endsAt:e.target.value})}/></label></div>
       <div className="two-col-form"><label>Total usage limit<input type="number" min="1" value={form.totalLimit} onChange={e=>setForm({...form,totalLimit:e.target.value})} placeholder="Unlimited"/></label><label>Per-customer limit<input type="number" min="1" value={form.customerLimit} onChange={e=>setForm({...form,customerLimit:e.target.value})} placeholder="Unlimited"/></label></div>
       {isOwner?
         <label>Branch scope<select value={form.branchId} onChange={e=>setForm({...form,branchId:e.target.value,categoryIds:[],itemIds:[]})}>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}<option value="">All branches</option></select></label>
         :
         <label>Branch scope<input value={lockedBranchName??''} disabled readOnly title="Branch managers can only create coupons for their own branch"/></label>
       }
       {form.branchId?<><div><b>Category scope (optional)</b><div className="build16-tag-select">{currentBranchCategories.map(c=><label key={c.id}><input type="checkbox" checked={form.categoryIds.includes(c.id)} onChange={e=>updateArray('categoryIds',c.id,e.target.checked)}/>{c.name}</label>)}</div></div><div><b>Product scope (optional)</b><div className="build16-tag-select">{currentBranchItems.slice(0,200).map(i=><label key={i.id}><input type="checkbox" checked={form.itemIds.includes(i.id)} onChange={e=>updateArray('itemIds',i.id,e.target.checked)}/>{i.name}</label>)}</div><small className="muted-small">Showing up to 200 available items for this branch.</small></div></>:<div className="notice notice-info">{isOwner?'This coupon will apply to every branch in this restaurant.':`Choose products or categories to scope this ${lockedBranchName} coupon, or leave blank to apply it to your whole branch menu.`}</div>}
       <div className="check-row"><label><input type="checkbox" checked={form.active} onChange={e=>setForm({...form,active:e.target.checked})}/> Active</label><label><input type="checkbox" checked={form.promote} onChange={e=>setForm({...form,promote:e.target.checked})}/> Promote this offer to customers</label></div>
       <div className="modal-actions"><button className="button button-light" type="button" onClick={()=>setShow(false)}>Cancel</button><button className="button button-primary" disabled={busy} onClick={()=>void save()}>{busy?<><Loader2 size={15} className="spin"/> Saving…</>:<><Tag size={15}/> Save coupon</>}</button></div>
     </div></div></div>:null}
   </StudioShell>;
 }
