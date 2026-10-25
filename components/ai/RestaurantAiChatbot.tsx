'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, LifeBuoy, MessageCircle, Sparkles, X } from 'lucide-react';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { AssistantChat } from './AssistantChat';
import styles from './RestaurantAiChatbot.module.css';

type AssistantTab = 'support' | 'analytics';

export function RestaurantAiChatbot() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<AssistantTab>('support');
  const [branchId, setBranchId] = useState('');
  const [branchError, setBranchError] = useState('');

  useEffect(() => {
    const client = getSupabaseBrowserClient();
    if (!client) return;
    let active = true;
    void getCurrentRestaurantContext(client).then((result) => {
      if (!active) return;
      if (!result.data) throw result.error ?? new Error('Restaurant workspace could not be loaded.');
      setBranchId(result.data.branch.id);
    }).catch((reason: unknown) => {
      if (active) setBranchError(reason instanceof Error ? reason.message : 'Restaurant workspace could not be loaded.');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const openAnalytics = () => { setTab('analytics'); setOpen(true); };
    window.addEventListener('tablely-open-ai-analytics', openAnalytics);
    return () => window.removeEventListener('tablely-open-ai-analytics', openAnalytics);
  }, []);

  return (
    <div className={styles.root}>
      <button type="button" className={styles.launcher} aria-label="Open TABLELY AI assistant" title="AI assistant" onClick={() => setOpen((value) => !value)}>
        <Sparkles size={17} />
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <>
          <button type="button" className={styles.backdrop} aria-label="Close AI assistant" onClick={() => setOpen(false)} />
          <section className={styles.panel} aria-label="TABLELY AI assistant">
            <header className={styles.header}>
              <div><span><Sparkles size={16} /> TABLELY assistant</span><small>{branchId ? 'Scoped to your active branch' : 'Checking workspace access…'}</small></div>
              <button type="button" className="icon-button" aria-label="Close assistant" onClick={() => setOpen(false)}><X size={16} /></button>
            </header>
            <nav className={styles.tabs} aria-label="Assistant topics">
              <button type="button" className={tab === 'support' ? styles.active : ''} aria-pressed={tab === 'support'} onClick={() => setTab('support')}><LifeBuoy size={15} /> Support</button>
              <button type="button" className={tab === 'analytics' ? styles.active : ''} aria-pressed={tab === 'analytics'} onClick={() => setTab('analytics')}><BarChart3 size={15} /> Analytics</button>
            </nav>
            {branchError ? <div className={styles.error} role="alert">{branchError}</div> : null}
            {branchId ? <AssistantChat key={`${tab}-${branchId}`} audience="staff" mode={tab} branchId={branchId} /> : null}
            <a className={styles.fullSupport} href={tab === 'analytics' ? '/analytics' : '/support'}>
              {tab === 'analytics' ? 'Open full analytics' : 'Open TABLELY support'} <MessageCircle size={13} />
            </a>
          </section>
        </>,
        document.body,
      ) : null}
    </div>
  );
}
