"use client";

import { useEffect,useState } from 'react';
import { Printer, RefreshCw } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { formatMoney } from '@/lib/customer';

type O={id:string;order_number:number|null;table_id:string;subtotal:number;tax:number;additional_charges:number;discount:number;total:number;payment_status:string;payment_method:string|null;coupon_code_snapshot:string|null;created_at:string};
type I={id:string;order_id:string;item_name_snapshot:string;quantity:number;unit_price:number;line_total:number;selected_addons:unknown;selected_options:unknown;configuration_snapshot:Record<string,unknown>|null;special_instructions:string|null};
type OptionRow={type?:string;name?:string;price_delta?:number};
type AddonRow={name?:string;price?:number};
function asRows<T>(value:unknown):T[]{
  if(Array.isArray(value)) return value.filter((x):x is T=>!!x && typeof x==='object') as T[];
  if(value && typeof value==='object'){
    const record=value as Record<string,unknown>;
    if('name' in record) return [record as T];
    return Object.values(record).flatMap((x)=>Array.isArray(x)?x:(x&&typeof x==='object'?[x]:[])) as T[];
  }
  return [];
}
function configLines(i:I){
  const out:string[]=[];
  for(const x of asRows<OptionRow>(i.selected_options)){
    if(!x.name) continue;
    out.push(x.type==='VARIANT'?`Size: ${x.name}`:`${x.name}${Number(x.price_delta)>0?` +₹${x.price_delta}`:''}`);
  }
  for(const x of asRows<AddonRow>(i.selected_addons)){
    if(!x.name) continue;
    out.push(`${x.name}${Number(x.price)>0?` +₹${x.price}`:''}`);
  }
  return out;
}
export default function BillsPage(){const s=getSupabaseBrowserClient();const[rows,setRows]=useState<O[]>([]);const[items,setItems]=useState<Record<string,I[]>>({});const[tables,setTables]=useState<Record<string,number>>({});const[loading,setLoading]=useState(true);const[refreshing,setRefreshing]=useState(false);const[error,setError]=useState<string|null>(null);const[printId,setPrintId]=useState<string|null>(null);
 async function load(){if(!s){setError('Supabase is not configured.');setLoading(false);return;}setRefreshing(true);try{const c=await getCurrentRestaurantContext(s);if(!c.data)throw c.error??new Error('Workspace not found.');const b=c.data.branch.id;const[{data:o,error:oe},{data:t,error:te}]=await Promise.all([s.from('orders').select('id,order_number,table_id,subtotal,tax,additional_charges,discount,total,payment_status,payment_method,coupon_code_snapshot,created_at').eq('branch_id',b).order('created_at',{ascending:false}).limit(100),s.from('tables').select('id,table_number').eq('branch_id',b)]);if(oe)throw oe;if(te)throw te;const ids=(o??[]).map(x=>x.id);let grouped:Record<string,I[]>={};if(ids.length){const{data:it,error:ie}=await s.from('order_items').select('id,order_id,item_name_snapshot,quantity,unit_price,line_total,selected_addons,selected_options,configuration_snapshot,special_instructions').in('order_id',ids);if(ie)throw ie;for(const x of it??[])(grouped[x.order_id]??=[]).push({...x,unit_price:Number(x.unit_price),line_total:Number(x.line_total)} as I);}setRows((o??[]).map(x=>({...x,subtotal:Number(x.subtotal),tax:Number(x.tax),additional_charges:Number(x.additional_charges),discount:Number(x.discount),total:Number(x.total)})) as O[]);setItems(grouped);setTables(Object.fromEntries((t??[]).map(x=>[x.id,x.table_number])));setError(null);setLoading(false);}catch(e:unknown){setError(e instanceof Error?e.message:'Could not load bills.');setLoading(false);}finally{setRefreshing(false);}}
 useEffect(()=>{void load()},[]);
 if(loading)return <StudioShell><div className="setup-loading">Loading bills…</div></StudioShell>;
 return <StudioShell><SectionHeader eyebrow="BILLING / OPERATIONS 2.0" title="Bills" description="Printable order bills with immutable menu configuration and authoritative payment totals." action={<button className="button button-light" onClick={()=>void load()} disabled={refreshing}><RefreshCw size={15} className={refreshing?'spin':''}/> Refresh</button>}/>{error?<div className="notice notice-error" role="alert">{error}</div>:null}<section className="bill-grid">{rows.map(o=>{const its=items[o.id]??[];return <article className={`surface-card bill-card ${printId && printId!==o.id?'print-exclude':''}`} key={o.id}><div className="bill-head"><div><strong>Bill #{o.order_number??o.id.slice(0,6)}</strong><span>Table {tables[o.table_id]??'—'} · {new Date(o.created_at).toLocaleString('en-IN')}</span></div><button className="button button-light compact no-print" onClick={()=>{setPrintId(o.id);window.setTimeout(()=>window.print(),0)}}><Printer size={14}/> Print</button></div><div className="bill-item-list">{its.map(i=><div className="bill-item-detail" key={i.id}><div><strong>{i.quantity} × {i.item_name_snapshot}</strong>{configLines(i).map(line=><small key={line}>{line}</small>)}{i.special_instructions?<small>Note: {i.special_instructions}</small>:null}</div><b>{formatMoney(i.line_total)}</b></div>)}</div><div className="bill-lines"><div><span>Subtotal</span><b>{formatMoney(o.subtotal)}</b></div>{o.coupon_code_snapshot?<div><span>Coupon</span><b>{o.coupon_code_snapshot}</b></div>:null}{o.discount>0?<div><span>Discount</span><b>-{formatMoney(o.discount)}</b></div>:null}<div><span>Tax</span><b>{formatMoney(o.tax)}</b></div>{o.additional_charges>0?<div><span>Additional charges</span><b>{formatMoney(o.additional_charges)}</b></div>:null}<div className="bill-total"><span>Total</span><strong>{formatMoney(o.total)}</strong></div></div><div className="bill-payment"><span>{o.payment_method??'—'}</span><strong>{o.payment_status}</strong></div></article>})}{rows.length===0?<div className="empty-wide">No bills yet.</div>:null}</section></StudioShell>;
}
