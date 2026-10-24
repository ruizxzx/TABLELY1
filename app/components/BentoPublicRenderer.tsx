'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { BentoBlock, BentoPageDesign, BentoViewport } from '../lib/bento';
import { getBentoCardShadow, getBentoEffectiveGridGap, getBentoPageBackground, isBentoBlockVisible, normalizeBentoPageDesign, resolveBentoBlocksForMobile } from '../lib/bento';
import BentoBlockView from './BentoBlock';
import BentoPublicCornerMenu from './BentoPublicCornerMenu';
import BentoPublicShell from './BentoPublicShell';
import BentoPublicViewBeacon from './BentoPublicViewBeacon';
import Logo from './Logo';

export type BentoPublicRendererProps = {
  blocks: BentoBlock[];
  design: BentoPageDesign;
  storeId?: string;
  shareUrl?: string;
  viewport?: BentoViewport;
  interactive?: boolean;
  showBeacon?: boolean;
};

function fontClass(font: BentoPageDesign['font']) {
  return font === 'editorial' ? 'bento-font-editorial' : font === 'mono' ? 'bento-font-mono' : font === 'clean' ? 'bento-font-clean' : 'bento-font-modern';
}

function motionClass(motion: BentoPageDesign['motion']) {
  return motion === 'calm' ? 'bento-motion-calm' : motion === 'cinematic' ? 'bento-motion-cinematic' : 'bento-motion-expressive';
}

function textureClass(texture: BentoPageDesign['texture']) {
  return texture === 'dots' ? 'bento-texture-dots' : texture === 'noise' ? 'bento-texture-noise' : texture === 'grain' ? 'bento-texture-grain' : 'bento-texture-none';
}

export default function BentoPublicRenderer({
  blocks,
  design,
  storeId,
  shareUrl,
  viewport = 'desktop',
  interactive = true,
  showBeacon = false,
}: BentoPublicRendererProps) {
  const resolvedDesign = normalizeBentoPageDesign(design);
  const visibleBlocks = blocks.filter(block => isBentoBlockVisible(block));
  const renderBlocks = resolveBentoBlocksForMobile(visibleBlocks, resolvedDesign.mobileMode);
  const pageWidth = resolvedDesign.pageWidth === 'wide' ? 980 : resolvedDesign.pageWidth === 'compact' ? 700 : 860;
  const align = resolvedDesign.pageAlignment === 'left' ? '0 auto 0 0' : resolvedDesign.pageAlignment === 'right' ? '0 0 0 auto' : '0 auto';
  const effectiveGridGap = getBentoEffectiveGridGap(resolvedDesign);
  const pointerFrameRef = useRef<number | null>(null);
  const pointerEventRef = useRef<{ target: HTMLElement; clientX: number; clientY: number } | null>(null);
  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') return;
    pointerEventRef.current = { target: event.currentTarget, clientX: event.clientX, clientY: event.clientY };
    if (pointerFrameRef.current !== null) return;
    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = null;
      const latest = pointerEventRef.current;
      if (!latest) return;
      const target = latest.target;
      const rect = target.getBoundingClientRect();
      target.style.setProperty('--bento-pointer-x', `${latest.clientX - rect.left}px`);
      target.style.setProperty('--bento-pointer-y', `${latest.clientY - rect.top}px`);
      target.style.setProperty('--bento-cursor-client-x', `${latest.clientX}px`);
      target.style.setProperty('--bento-cursor-client-y', `${latest.clientY}px`);
      target.dataset.bentoCursorActive = 'true';
    });
  };

  const handlePointerLeave = (event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.dataset.bentoCursorActive = 'false';
  };

  useEffect(() => () => { if (pointerFrameRef.current !== null) window.cancelAnimationFrame(pointerFrameRef.current); }, []);

  const renderIndex = new Map(renderBlocks.map((block, index) => [block.id, index]));
  const styles = {
    background: getBentoPageBackground(resolvedDesign),
    color: resolvedDesign.textColor || '#171811',
    ['--hub-accent' as string]: resolvedDesign.accent,
    ['--hub-muted' as string]: resolvedDesign.mutedTextColor || '#68695e',
    ['--bento-page-width' as string]: `${pageWidth}px`,
    ['--bento-grid-gap' as string]: `${effectiveGridGap}px`,
    ['--bento-card-radius' as string]: `${Math.max(8, Math.min(64, Number(resolvedDesign.cardRadius) || 28))}px`,
    ['--bento-noise-opacity' as string]: resolvedDesign.noise === false ? 0 : .07,
    ['--bento-animation-intensity' as string]: `${Math.max(0, Math.min(100, Number(resolvedDesign.animationIntensity ?? 70))) / 100}`,
    ['--bento-page-align' as string]: resolvedDesign.pageAlignment || 'center',
    ['--bento-global-card-shadow' as string]: getBentoCardShadow(resolvedDesign.cardShadow),
    ['--bento-global-margin' as string]: align,
  } as CSSProperties;

  return (
    <BentoPublicShell>
      {showBeacon && storeId ? <BentoPublicViewBeacon storeId={storeId} /> : null}
      <main onPointerMove={handlePointerMove} onPointerLeave={handlePointerLeave} data-bento-cursor-fx={resolvedDesign.cursorFx} data-bento-spotlight={resolvedDesign.spotlight === false ? 'off' : 'on'} data-bento-cursor-active="false" className={`link-hub-public bento-public-page ${fontClass(resolvedDesign.font)} ${motionClass(resolvedDesign.motion)} ${textureClass(resolvedDesign.texture)} bento-density-${resolvedDesign.contentDensity || 'comfortable'} bento-global-shadow-${resolvedDesign.cardShadow || 'soft'} bento-button-style-${resolvedDesign.buttonStyle || 'solid'}`} style={styles}>
        <span className="bento-cursor-orb" aria-hidden="true" />
        <div className="link-hub-public-inner bento-public-inner">
          <div className="bento-public-toolbar">
            <div className="bento-public-brand"><Logo /></div>
            {shareUrl ? <BentoPublicCornerMenu shareUrl={shareUrl} /> : null}
          </div>

          {renderBlocks.length > 0 ? (
            <section className="bento-public-canvas" aria-label="Creator profile and content" data-bento-responsive="true">
              {renderBlocks.map(block => (
                <BentoBlockView
                  key={block.id}
                  block={block}
                  storeId={storeId}
                  interactive={interactive}
                  layoutContext={renderBlocks}
                  layoutMode="positioned"
                  viewport={viewport}
                  globalCardRadius={resolvedDesign.cardRadius}
                  globalCursorFx={resolvedDesign.cursorFx}
                  animationIndex={renderIndex.get(block.id) ?? 0}
                />
              ))}
            </section>
          ) : (
            <section className="bento-public-empty" aria-label="Published page is empty">
              <strong>This page has no published content yet.</strong>
            </section>
          )}

          <div className="bento-public-meta">
            <Link href="/">TABLELY</Link>
            <span>One page. Your whole internet.</span>
          </div>
        </div>
      </main>
    </BentoPublicShell>
  );
}
