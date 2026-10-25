'use client';
import Link from 'next/link';
import { CreditCard, ReceiptText, LogOut, ShieldCheck, Palette, Globe2, Shield, BadgeCheck, Bell, Tag, MessageSquare, AlertTriangle, Bike } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { FeedbackForm } from '@/components/FeedbackForm';

type Permissions = Record<string, boolean>;

export default function SettingsPage(){
 const router=useRouter();
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState<string|null>(null);
 const[role,setRole]=useState<string>('');
 const[permissions,setPermissions]=useState<Permissions>({});
 const[features,setFeatures]=useState<Permissions>({});
 const[feedbackOpen,setFeedbackOpen]=useState(false);
 useEffect(()=>{
   const s=getSupabaseBrowserClient();
   if(!s)return;
   let active=true;
   (async()=>{
     const context=await getCurrentRestaurantContext(s);
     if(!active || !context.data)return;
     const staff=context.data.staff;
     setRole(staff.role);
     if(staff.role !== 'OWNER') {
       const {data}=await s.from('staff_permissions').select('permission,allowed').eq('staff_id',staff.id);
       if(!active)return;
       const map:Permissions={};
       for(const row of (data??[]) as {permission:string;allowed:boolean}[]) map[row.permission]=Boolean(row.allowed);
       setPermissions(map);
     }
     const {data:entitlementData}=await s.rpc('get_current_entitlements');
     if(!active)return;
     const f=entitlementData&&typeof entitlementData==='object'?((entitlementData as {features?:Permissions}).features??{}):{};
     setFeatures(f);
   })();
   return()=>{active=false};
 },[]);
 const owner=role==='OWNER';
 const can=(permission:string)=>owner || permissions[permission]===true;
 const canOnlinePayments=owner || (permissions.PAYMENTS===true && features.ONLINE_PAYMENTS!==false);
 async function signOut(){const s=getSupabaseBrowserClient();if(!s)return;setBusy(true);setError(null);const{error:e}=await s.auth.signOut();if(e){setError(e.message);setBusy(false);return}router.replace('/login');router.refresh();}
 return <StudioShell><SectionHeader eyebrow="SETTINGS" title="Settings" description="Restaurant configuration, payments and your account."/><div className="settings-grid">
   {canOnlinePayments?<Link className="surface-card settings-tile" href="/settings/payments"><CreditCard size={20}/><div><strong>Online payments</strong><span>Configure branch-specific Razorpay payments and safe fallback defaults.</span></div></Link>:null}
   {can('CHARGES')?<Link className="surface-card settings-tile" href="/settings/charges"><ReceiptText size={20}/><div><strong>Checkout charges</strong><span>Configure branch-specific GST, platform and other customer charges.</span></div></Link>:null}
   {owner || can('MANAGE_ONLINE_ORDERING')?<Link className="surface-card settings-tile" href="/settings/online-ordering"><Bike size={20}/><div><strong>Online Ordering & Fulfillment</strong><span>Pickup, delivery zones, packaging charges, order limits and schedule settings.</span></div></Link>:null}
   {can('DISCOUNTS_COUPONS')?<Link className="surface-card settings-tile" href="/settings/coupons"><Tag size={20}/><div><strong>Coupons & offers</strong><span>{owner?'Create discounts, limits, scopes and customer-facing promotions.':'Manage discounts and offers for your branch.'}</span></div></Link>:null}
   <Link className="surface-card settings-tile" href="/settings/branding"><Palette size={20}/><div><strong>Branding studio</strong><span>Restaurant logo, colors and customer-facing menu theme.</span></div></Link>
   <button className="surface-card settings-tile settings-tile-button" type="button" onClick={()=>setFeedbackOpen(true)}><MessageSquare size={20}/><div><strong>Report a problem / suggest an idea</strong><span>Send feedback directly to the Tablely admin team.</span></div></button>
   {owner?<><Link className="surface-card settings-tile" href="/settings/domain"><Globe2 size={20}/><div><strong>Custom domain</strong><span>Configure and verify a Pro customer-facing hostname.</span></div></Link><Link className="surface-card settings-tile" href="/staff/permissions"><Shield size={20}/><div><strong>Advanced permissions</strong><span>Fine-grained access controls for staff.</span></div></Link><Link className="surface-card settings-tile" href="/settings/notifications"><Bell size={20}/><div><strong>Notification preferences</strong><span>Choose which branches can notify the Owner account.</span></div></Link></>:null}
   {can('SUBSCRIPTION_MANAGEMENT')?<Link className="surface-card settings-tile" href="/dashboard/subscription"><BadgeCheck size={20}/><div><strong>Subscription</strong><span>View the current Tablely plan, billing history and subscription status.</span></div></Link>:null}
   <section className="surface-card settings-tile"><ShieldCheck size={20}/><div><strong>Account security</strong><span>Sign out of this Tablely session.</span><button className="button button-light" type="button" onClick={()=>void signOut()} disabled={busy}><LogOut size={15}/>{busy?'Signing out…':'Sign out'}</button>{error?<small className="notice notice-error">{error}</small>:null}</div></section>
   {owner?<Link className="surface-card settings-tile danger-zone-tile" href="/settings/danger"><AlertTriangle size={20}/><div><strong>Danger zone</strong><span>Permanently delete this restaurant and all of its data.</span></div></Link>:null}
 </div>{feedbackOpen?<FeedbackForm source="RESTAURANT" onClose={()=>setFeedbackOpen(false)}/>:null}</StudioShell>;
}
