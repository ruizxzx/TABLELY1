'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { BentoBlock, BentoPageDesign, BentoViewport } from '../lib/bento';

const VIEWPORT_WIDTHS: Record<BentoViewport, number> = { desktop: 1280, tablet: 820, mobile: 360 };
const VIEWPORT_HEIGHTS: Partial<Record<BentoViewport, number>> = { mobile: 800 };

export default function BentoPublicPreviewFrame({
  blocks,
  design,
  viewport,
  storeId,
  shareUrl = '',
  zoom = 100,
}: {
  blocks: BentoBlock[];
  design: BentoPageDesign;
  viewport: BentoViewport;
  storeId?: string;
  shareUrl?: string;
  zoom?: number;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = useState(900);
  const [contentHeight, setContentHeight] = useState(900);
  const [ready, setReady] = useState(false);
  const baseWidth = VIEWPORT_WIDTHS[viewport];
  const scale = useMemo(() => Math.min(1, frameWidth / baseWidth) * (zoom / 100), [frameWidth, baseWidth, zoom]);
  const viewportHeight = VIEWPORT_HEIGHTS[viewport];
  const scaledHeight = viewportHeight ? Math.ceil(viewportHeight * scale) : Math.max(500, Math.ceil(contentHeight * scale));
  const iframeHeight = viewportHeight || contentHeight;

  const postState = useCallback(() => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    target.postMessage({
      type: 'TABLELY_BENTO_PREVIEW',
      payload: { blocks, design, viewport, storeId, shareUrl },
    }, window.location.origin);
  }, [blocks, design, viewport, storeId, shareUrl]);

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width || 900;
      setFrameWidth(width);
    });
    observer.observe(node);
    setFrameWidth(node.getBoundingClientRect().width || 900);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === 'TABLELY_BENTO_PREVIEW_READY') {
        setReady(true);
        postState();
      }
      if (event.data?.type === 'TABLELY_BENTO_PREVIEW_HEIGHT') {
        const height = Number(event.data.height);
        if (Number.isFinite(height) && height > 0) setContentHeight(Math.min(12000, height));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [postState]);

  useEffect(() => {
    if (ready) postState();
  }, [ready, postState]);

  const frameStyle: CSSProperties = {
    height: scaledHeight,
    overflow: 'hidden',
    position: 'relative',
    borderRadius: 24,
    background: '#eef0f5',
  };
  const iframeStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: '50%',
    width: baseWidth,
    height: iframeHeight,
    border: 0,
    background: 'transparent',
    transform: `translateX(-50%) scale(${scale})`,
    transformOrigin: 'top center',
    boxShadow: '0 18px 50px rgba(20,22,30,.12)',
    borderRadius: 28,
  };

  return <div ref={frameRef} className={`bento-real-preview bento-real-preview-${viewport}`} style={frameStyle}>
    <iframe
      ref={iframeRef}
      title="Live public Link Hub preview"
      src="/bento-preview"
      onLoad={postState}
      style={iframeStyle}
      sandbox="allow-scripts allow-forms allow-same-origin"
    />
  </div>;
}
