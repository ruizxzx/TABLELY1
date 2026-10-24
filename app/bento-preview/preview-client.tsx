'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BentoBlock, BentoPageDesign, BentoViewport } from '../lib/bento';
import { BENTO_PAGE_DESIGN_DEFAULTS, normalizeBentoPageDesign } from '../lib/bento';
import BentoPublicRenderer from '../components/BentoPublicRenderer';

type PreviewState = {
  blocks: BentoBlock[];
  design: BentoPageDesign;
  viewport: BentoViewport;
  storeId?: string;
  shareUrl?: string;
};

const DEFAULT_DESIGN = normalizeBentoPageDesign(BENTO_PAGE_DESIGN_DEFAULTS);

function isValidViewport(value: unknown): value is BentoViewport {
  return value === 'desktop' || value === 'tablet' || value === 'mobile';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

export default function BentoPreviewClient() {
  const [state, setState] = useState<PreviewState | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== window.parent) return;
      if (!isObject(event.data) || event.data.type !== 'TABLELY_BENTO_PREVIEW') return;
      if (!isObject(event.data.payload)) return;

      const payload = event.data.payload;
      if (!Array.isArray(payload.blocks) || !isObject(payload.design)) return;
      setState({
        blocks: payload.blocks as BentoBlock[],
        design: normalizeBentoPageDesign({ ...DEFAULT_DESIGN, ...(payload.design as Partial<BentoPageDesign>) }),
        viewport: isValidViewport(payload.viewport) ? payload.viewport : 'desktop',
        storeId: typeof payload.storeId === 'string' ? payload.storeId : undefined,
        shareUrl: typeof payload.shareUrl === 'string' ? payload.shareUrl : undefined,
      });
    };

    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'TABLELY_BENTO_PREVIEW_READY' }, window.location.origin);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !state) return;

    const sendHeight = () => {
      const height = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        root.scrollHeight,
        root.getBoundingClientRect().height,
      );
      window.parent.postMessage({ type: 'TABLELY_BENTO_PREVIEW_HEIGHT', height: Math.ceil(height) }, window.location.origin);
    };

    sendHeight();
    const observer = new ResizeObserver(sendHeight);
    observer.observe(root);
    return () => observer.disconnect();
  }, [state]);

  if (!state) {
    return <main className="bento-preview-loading" aria-live="polite" />;
  }

  return (
    <div ref={rootRef} className="bento-preview-root">
      <BentoPublicRenderer
        blocks={state.blocks}
        design={state.design}
        storeId={state.storeId}
        shareUrl={state.shareUrl}
        viewport={state.viewport}
        interactive={false}
        showBeacon={false}
      />
    </div>
  );
}
