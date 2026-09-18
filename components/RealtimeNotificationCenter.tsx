'use client';
import { Bell, Check, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { playNotificationSound, primeNotificationSound } from '@/lib/notification-sound';
import { requestBrowserNotifications, showBrowserOrderNotification } from '@/lib/realtime-notifications';

type N={id:string;branch_id:string;recipient_staff_id:string;type:string;title:string;message:string;entity_type:string|null;entity_id:string|null;metadata:Record<string,unknown>|null;read_at:string|null;created_at:string};
type Scope={staffId:string;owner:boolean;branchIds:string[];organizationId:string};

export function RealtimeNotificationCenter(){
  const s=getSupabaseBrowserClient();
  const [rows,setRows]=useState<N[]>([]);
  const [toasts,setToasts]=useState<N[]>([]);
  const [open,setOpen]=useState(false);
  const [sound,setSound]=useState(false);
  const [unread,setUnread]=useState(0);
  const [liveStatus,setLiveStatus]=useState<'connecting'|'live'|'reconnecting'|'offline'>('connecting');
  const staffRef=useRef<string|null>(null);
  const scopeRef=useRef<Scope|null>(null);
  const soundRef=useRef(false);
  const seenIdsRef=useRef<Set<string>>(new Set());

  useEffect(()=>{
    if(!s)return;
    let ch:ReturnType<typeof s.channel>|null=null;
    let active=true;
    const liveStatusRefLocal={current:'connecting' as 'connecting'|'live'|'reconnecting'|'offline'};

    const buildScope=async():Promise<Scope|null>=>{
      const c=await getCurrentRestaurantContext(s);
      if(!c.data)return null;
      const staffId=c.data.staff.id;
      const owner=c.data.staff.role==='OWNER';
      if(owner){
        const [{data:branches,error:be},{data:prefs,error:pe}]=await Promise.all([
          s.from('branches').select('id').eq('organization_id',c.data.organization.id).eq('is_active',true),
          s.from('owner_notification_preferences').select('branch_id,enabled').eq('organization_id',c.data.organization.id).eq('owner_user_id',c.data.userId)
        ]);
        if(be||pe)return null;
        const enabled=new Set(((prefs??[]) as {branch_id:string;enabled:boolean}[]).filter(x=>x.enabled).map(x=>x.branch_id));
        return {staffId,owner,organizationId:c.data.organization.id,branchIds:((branches??[]) as {id:string}[]).map(b=>b.id).filter(id=>enabled.has(id))};
      }
      return {staffId,owner,organizationId:c.data.organization.id,branchIds:c.data.branch.id?[c.data.branch.id]:[]};
    };

    const load=async()=>{
      const scope=await buildScope();
      if(!scope||!active)return;
      scopeRef.current=scope; staffRef.current=scope.staffId;
      if(scope.branchIds.length===0){setRows([]);setUnread(0);return;}
      const [{data,error},{count,error:countError}]=await Promise.all([
        s.from('notifications').select('*').eq('recipient_staff_id',scope.staffId).in('branch_id',scope.branchIds).order('created_at',{ascending:false}).limit(50),
        s.from('notifications').select('id',{count:'exact',head:true}).eq('recipient_staff_id',scope.staffId).in('branch_id',scope.branchIds).is('read_at',null)
      ]);
      if(!active)return;
      if(error){setLiveStatus('reconnecting');liveStatusRefLocal.current='reconnecting';return;}
      const loadedRows=(data??[]) as N[];
      for(const n of loadedRows)seenIdsRef.current.add(n.id);
      setRows(loadedRows);
      setUnread(typeof count==='number'&&!countError?count:((data??[]) as N[]).filter(n=>!n.read_at).length);
    };

    const refreshUnread=async()=>{
      const scope=scopeRef.current;
      if(!scope||scope.branchIds.length===0){setUnread(0);return;}
      const {count,error}=await s.from('notifications').select('id',{count:'exact',head:true}).eq('recipient_staff_id',scope.staffId).in('branch_id',scope.branchIds).is('read_at',null);
      if(!error&&typeof count==='number')setUnread(count);
    };

    const handleInsert=(p:{new:unknown})=>{
      const n=p.new as N; const scope=scopeRef.current;
      if(!scope||!scope.branchIds.includes(n.branch_id))return;
      if(seenIdsRef.current.has(n.id))return;
      seenIdsRef.current.add(n.id);
      setRows(cur=>[n,...cur].slice(0,50));
      setToasts(cur=>[n,...cur.filter(x=>x.id!==n.id)].slice(0,4));
      setUnread(cur=>cur+1);
      if(soundRef.current)void playNotificationSound();
      showBrowserOrderNotification({title:n.title,message:n.message});
      // Belt-and-suspenders resync: the orders list has its own independent
      // realtime subscription on the `orders` table. If that channel ever
      // misses an event (a brief reconnect, or an HMR-torn effect in dev)
      // while this notifications channel still delivers, this event tells
      // any listening order views to refetch rather than silently drifting
      // until the next 20s poll.
      if(typeof window!=='undefined'&&n.entity_type==='ORDER'&&n.entity_id){
        window.dispatchEvent(new CustomEvent('tablely-order-changed',{detail:{branchId:n.branch_id,orderId:n.entity_id}}));
      }
    };
    const handleUpdate=(p:{new:unknown})=>{
      const n=p.new as N;
      setRows(cur=>cur.map(x=>x.id===n.id?n:x));
      void refreshUnread();
    };

    const start=async()=>{
      const scope=await buildScope();
      if(!scope||!active)return;
      scopeRef.current=scope;staffRef.current=scope.staffId;
      await load();
      if(!active)return;
      ch=s.channel(`tablely:notifications:${scope.staffId}`)
        .on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications',filter:`recipient_staff_id=eq.${scope.staffId}`},handleInsert)
        .on('postgres_changes',{event:'UPDATE',schema:'public',table:'notifications',filter:`recipient_staff_id=eq.${scope.staffId}`},handleUpdate)
        .subscribe((status)=>{
          if(status==='SUBSCRIBED'){liveStatusRefLocal.current='live';setLiveStatus('live');void load();}
          else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'){liveStatusRefLocal.current='reconnecting';setLiveStatus('reconnecting');}
          else if(status==='CLOSED'){liveStatusRefLocal.current='offline';setLiveStatus('offline');}
          else {liveStatusRefLocal.current='reconnecting';setLiveStatus('reconnecting');}
        });
    };

    void start();
    const timer=window.setInterval(()=>{if(liveStatusRefLocal.current!=='live')void load();},20000);
    const onPreferenceChange=()=>void load();
    const onOnline=()=>{liveStatusRefLocal.current='reconnecting';setLiveStatus('reconnecting');void load();};
    const onVisibility=()=>{if(document.visibilityState==='visible')void load();};
    window.addEventListener('tablely-notification-preferences-changed',onPreferenceChange);
    window.addEventListener('online',onOnline);
    document.addEventListener('visibilitychange',onVisibility);
    return()=>{
      active=false;window.clearInterval(timer);
      window.removeEventListener('tablely-notification-preferences-changed',onPreferenceChange);
      window.removeEventListener('online',onOnline);document.removeEventListener('visibilitychange',onVisibility);
      if(ch)void s.removeChannel(ch);
    };
  },[]);
  const liveStatusRef=useRef(liveStatus);
  useEffect(()=>{liveStatusRef.current=liveStatus;},[liveStatus]);
  useEffect(()=>{if(!toasts.length)return;const t=window.setTimeout(()=>setToasts(cur=>cur.slice(0,-1)),6000);return()=>window.clearTimeout(t)},[toasts.length]);
  async function enableSound(){if(!(await primeNotificationSound()))return;soundRef.current=true;setSound(true);await requestBrowserNotifications();await playNotificationSound()}
  async function markRead(id:string){if(!s)return;const before=rows.find(n=>n.id===id);const now=new Date().toISOString();const{error}=await s.from('notifications').update({read_at:now}).eq('id',id);if(!error)setRows(cur=>cur.map(n=>n.id===id?{...n,read_at:now}:n));if(!error&&before&&!before.read_at)setUnread(v=>Math.max(0,v-1));}
  async function markAll(){if(!s||!staffRef.current)return;const scope=scopeRef.current;if(!scope||scope.branchIds.length===0)return;const now=new Date().toISOString();const{error}=await s.from('notifications').update({read_at:now}).eq('recipient_staff_id',staffRef.current).in('branch_id',scope.branchIds).is('read_at',null);if(!error){setRows(cur=>cur.map(n=>scope.branchIds.includes(n.branch_id)?{...n,read_at:n.read_at??now}:n));setUnread(0);}}

  const statusText=liveStatus==='live'?'Live':liveStatus==='offline'?'Offline':'Reconnecting';
  return <>
    <div className="notification-toast-stack" aria-live="polite">{toasts.map(n=><div className="notification-toast" key={n.id}><span className="notification-entry-dot"/><div><strong>{n.title}</strong><span>{n.message}</span></div><button className="icon-button" onClick={()=>setToasts(cur=>cur.filter(x=>x.id!==n.id))}><X size={14}/></button></div>)}</div>
    <div className="notification-center">
      <button className="notification-center-trigger" onClick={()=>setOpen(v=>!v)} aria-label={`Notifications${unread?`, ${unread} unread`:''}`}><Bell size={17}/>{unread?<span className="notification-count">{unread>99?'99+':unread}</span>:null}</button>
      {open?<div className="notification-popover"><div className="notification-popover-head"><div><strong>Notifications</strong><span>{unread?`${unread} unread`:'All caught up'} · {statusText}</span></div><div className="button-row"><button className="icon-button" onClick={()=>void markAll()} title="Mark all read"><Check size={15}/></button><button className="icon-button" onClick={()=>setOpen(false)} title="Close"><X size={15}/></button></div></div>{!sound?<button className="notification-sound-enable" onClick={()=>void enableSound()}>Enable notification sound</button>:<div className="notification-sound-enabled">Sound enabled</div>}<div className="notification-list">{rows.map(n=><button key={n.id} className={`notification-entry ${n.read_at?'read':'unread'}`} onClick={()=>void markRead(n.id)}><span className="notification-entry-dot"/><span><strong>{n.title}</strong><small>{n.message}</small><em>{new Date(n.created_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</em></span></button>)}{!rows.length?<div className="notification-empty">No notifications selected for this view.</div>:null}</div></div>:null}
    </div>
  </>;
}
