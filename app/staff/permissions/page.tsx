'use client';
import { useEffect, useMemo, useState } from 'react';
import { MapPin, Save, Search, Shield, UserRound } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { BUILD12_PERMISSIONS, type Build12Permission } from '@/lib/tablely-build12';

type Staff={
  id:string; user_id:string; display_name:string|null; role:string; active:boolean;
  branch_id:string|null; email:string|null;
};
type Branch={id:string;name:string};

export default function PermissionsPage(){
  const s=getSupabaseBrowserClient();
  const[rows,setRows]=useState<Staff[]>([]),[branches,setBranches]=useState<Branch[]>([]);
  const[perms,setPerms]=useState<Record<string,Record<string,boolean>>>({});
  const[loading,setLoading]=useState(true),[saving,setSaving]=useState<string|null>(null);
  const[error,setError]=useState<string|null>(null),[query,setQuery]=useState('');

  async function load(){
    if(!s){setError('Supabase is not configured.');setLoading(false);return;}
    const c=await getCurrentRestaurantContext(s);
    if(!c.data){setError(c.error?.message??'Workspace not found.');setLoading(false);return;}
    if(c.data.staff.role!=='OWNER'){setError('Only the owner can manage advanced permissions.');setLoading(false);return;}

    const[{data:staffData,error:e1},{data:ps,error:e2},{data:branchData}]=await Promise.all([
      s.rpc('list_staff_with_email'),
      s.from('staff_permissions').select('staff_id,permission,allowed'),
      s.from('branches').select('id,name').eq('organization_id',c.data.organization.id).order('created_at'),
    ]);
    if(e1||e2){setError((e1??e2)?.message??'Could not load permissions.');setLoading(false);return;}

    const next:Record<string,Record<string,boolean>>={};
    for(const p of ps??[]){next[p.staff_id]??={};next[p.staff_id][p.permission]=Boolean(p.allowed);}
    setRows((staffData??[]) as Staff[]);
    setBranches((branchData??[]) as Branch[]);
    setPerms(next);
    setLoading(false);
  }

  useEffect(()=>{void load()},[]);

  async function toggle(staffId:string,permission:Build12Permission){
    const next=!perms[staffId]?.[permission];
    setPerms(x=>({...x,[staffId]:{...x[staffId],[permission]:next}}));
    setSaving(`${staffId}:${permission}`);setError(null);
    const{error:e}=await s!.rpc('set_staff_permission',{p_staff_id:staffId,p_permission:permission,p_allowed:next});
    if(e){setError(e.message);setPerms(x=>({...x,[staffId]:{...x[staffId],[permission]:!next}}));}
    setSaving(null);
  }

  const filteredRows=useMemo(()=>{
    const q=query.trim().toLowerCase();
    if(!q)return rows;
    return rows.filter(r=>{
      const branch=branches.find(b=>b.id===r.branch_id)?.name??'';
      return [r.display_name??'',r.email??'',r.role,branch].some(v=>v.toLowerCase().includes(q));
    });
  },[rows,branches,query]);

  const permissionGroups=[
    {title:'Orders & kitchen',keys:['VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS']},
    {title:'Finance',keys:['BILLING','CHARGES','PAYMENTS','DISCOUNTS_COUPONS']},
    {title:'Operations',keys:['STAFF_MANAGEMENT','ANALYTICS','SETTINGS','MENU_MANAGEMENT','BRANCH_MANAGEMENT','SUBSCRIPTION_MANAGEMENT']},
  ];

  if(loading)return <StudioShell><div className="setup-loading">Loading permissions…</div></StudioShell>;

  return <StudioShell>
    <SectionHeader eyebrow="SECURITY" title="Advanced permissions" description="Fine-grained access controls for staff. Changes save immediately and are enforced by the database permission layer."/>
    <div className="notice notice-info"><Shield size={15}/> Owners cannot be modified here. Use these controls only for non-owner staff and trusted branch operators.</div>
    {error?<div className="notice notice-error" role="alert">{error}</div>:null}

    <section className="surface-card permission-card">
      <div className="permission-toolbar">
        <div><strong>{rows.length} staff account{rows.length===1?'':'s'}</strong><span>Manage access by staff member, branch and role.</span></div>
        <label className="permission-search"><Search size={14}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search name, email or branch" aria-label="Search staff"/></label>
      </div>
      <div className="permission-groups">{permissionGroups.map(g=><span key={g.title} className="permission-group-chip"><b>{g.title}</b> {g.keys.length}</span>)}</div>

      <div className="permission-table">
        <div className="permission-head">
          <span>Staff member</span>{BUILD12_PERMISSIONS.map(([key])=><span key={key} title={key}>{key.replaceAll('_',' ')}</span>)}
        </div>
        {filteredRows.map(r=>{
          const branch=branches.find(b=>b.id===r.branch_id)?.name??'Unassigned';
          const label=r.display_name||r.email||r.id.slice(0,8);
          const initials=label.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase();
          return <div className="permission-row" key={r.id}>
            <div className="permission-person">
              <div className="permission-avatar"><span>{initials||<UserRound size={15}/>}</span></div>
              <div className="permission-person-copy">
                <strong>{label}</strong>
                <span className="permission-email">{r.email??'No login email available'}</span>
                <span className="permission-meta"><b>{r.role}</b><i>·</i><MapPin size={11}/>{branch}<i>·</i>{r.active?'Active':'Disabled'}</span>
              </div>
            </div>
            {BUILD12_PERMISSIONS.map(([key])=>{const id=`${r.id}:${key}`;return <button key={key} className={`permission-toggle ${perms[r.id]?.[key]?'on':''}`} disabled={r.role==='OWNER'||saving===id} onClick={()=>void toggle(r.id,key)} aria-label={`${key} ${perms[r.id]?.[key]?'enabled':'disabled'}`} title={`${key.replaceAll('_',' ')}: ${perms[r.id]?.[key]?'Enabled':'Disabled'}`}><span>{saving===id?'…':perms[r.id]?.[key]?'✓':'—'}</span></button>})}
          </div>;
        })}
      </div>
      {rows.length===0?<div className="menu-empty">No non-owner staff accounts exist yet.</div>:null}
      {rows.length>0&&filteredRows.length===0?<div className="menu-empty">No staff matched “{query}”.</div>:null}
    </section>
    <div className="permission-mobile-note"><Save size={14}/> Changes save immediately. Staff identity shows the current login email and branch so permission changes are easier to audit.</div>
  </StudioShell>;
}
