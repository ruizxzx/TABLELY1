'use client';
import { Bell, Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';

type Branch={id:string;name:string;is_active:boolean};
type Pref={branch_id:string;enabled:boolean};

export default function NotificationSettingsPage(){
  const s=getSupabaseBrowserClient();
  const [branches,setBranches]=useState<Branch[]>([]);
  const [enabled,setEnabled]=useState<Record<string,boolean>>({});
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [saved,setSaved]=useState<string|null>(null);

  async function load(){
    if(!s)return;
    setLoading(true);setError(null);
    const c=await getCurrentRestaurantContext(s);
    if(!c.data){setError(c.error?.message??'Workspace not found.');setLoading(false);return;}
    if(c.data.staff.role!=='OWNER'){setError('Only the organization owner can manage notification preferences.');setLoading(false);return;}
    const [{data:b,error:be},{data:p,error:pe}]=await Promise.all([
      s.from('branches').select('id,name,is_active').eq('organization_id',c.data.organization.id).order('created_at'),
      s.from('owner_notification_preferences').select('branch_id,enabled').eq('organization_id',c.data.organization.id).eq('owner_user_id',c.data.userId)
    ]);
    if(be||pe){setError((be??pe)?.message??'Could not load notification preferences.');setLoading(false);return;}
    const map:Record<string,boolean>={};
    for(const row of (p??[]) as Pref[])map[row.branch_id]=Boolean(row.enabled);
    setBranches((b??[]) as Branch[]);setEnabled(map);setLoading(false);
  }
  useEffect(()=>{void load();},[]);

  async function toggle(branchId:string,next:boolean){
    if(!s||busy)return;
    setBusy(branchId);setError(null);setSaved(null);
    const {error:e}=await s.rpc('set_owner_notification_preference',{p_branch_id:branchId,p_enabled:next});
    if(e){setError(e.message);} else {setEnabled(cur=>({...cur,[branchId]:next}));setSaved(branchId);window.dispatchEvent(new Event('tablely-notification-preferences-changed'));window.setTimeout(()=>setSaved(null),1400);}
    setBusy(null);
  }

  if(loading)return <StudioShell><div className="setup-loading">Loading notification preferences…</div></StudioShell>;
  return <StudioShell><SectionHeader eyebrow="NOTIFICATIONS" title="Notification preferences" description="Choose which branches can generate notifications for the Owner account."/><section className="surface-card settings-card"><div className="card-heading"><div><h2>Owner notifications</h2><p>This does not change branch access or permissions. It only controls notification delivery.</p></div><Bell size={20}/></div>{error?<div className="notice notice-error">{error}</div>:null}<div className="notification-preference-list">{branches.map(branch=><div className="notification-preference-row" key={branch.id}><div><strong>{branch.name}</strong><span>{branch.is_active?'Active branch':'Inactive branch'}</span></div><button type="button" className={`notification-preference-toggle ${enabled[branch.id]?'enabled':''}`} onClick={()=>void toggle(branch.id,!enabled[branch.id])} disabled={busy===branch.id} aria-pressed={Boolean(enabled[branch.id])} aria-label={`${enabled[branch.id]?'Disable':'Enable'} notifications for ${branch.name}`}>{enabled[branch.id]?<Check size={16}/>:<X size={16}/>}<span>{busy===branch.id?'Saving…':enabled[branch.id]?'Enabled':'Disabled'}</span></button>{saved===branch.id?<small className="notification-saved">Saved</small>:null}</div>)}{!branches.length?<div className="notification-empty">No branches found.</div>:null}</div></section></StudioShell>;
}
