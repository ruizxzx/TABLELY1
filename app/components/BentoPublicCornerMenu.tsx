'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

export default function BentoPublicCornerMenu({ shareUrl }: { shareUrl: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (open) firstActionRef.current?.focus();
  }, [open]);

  const handleShare = async () => {
    const absoluteShareUrl = (() => {
      try { return new URL(shareUrl, window.location.origin).href; }
      catch { return shareUrl; }
    })();
    const shareData = {
      title: 'TABLELY',
      text: 'Check this page',
      url: absoluteShareUrl,
    };

    try {
      if (navigator.share && typeof navigator.share === 'function') {
        await navigator.share(shareData);
        setOpen(false);
        return;
      }

      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(absoluteShareUrl);
      } else {
        const input = document.createElement('input');
        input.value = absoluteShareUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }

      setCopied(true);
      setOpen(false);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(absoluteShareUrl);
        } else {
          const input = document.createElement('input');
          input.value = absoluteShareUrl;
          document.body.appendChild(input);
          input.select();
          document.execCommand('copy');
          document.body.removeChild(input);
        }

        setCopied(true);
      } catch {
        setCopied(false);
      }
      setOpen(false);
    }
  };

  return (
    <div className="bento-public-menu" ref={menuRef}>
      <button
        type="button"
        className="bento-public-dots-button"
        aria-label="Open share and account menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="bento-public-dots"><i /><i /><i /></span>
      </button>

      {open && (
        <div className="bento-public-menu-panel" role="menu" aria-label="Public page actions">
          <button ref={firstActionRef} type="button" className="bento-public-menu-item" onClick={handleShare}>
            {copied ? 'Link copied' : 'Share this page'}
          </button>
          <Link href="/signup" className="bento-public-menu-item" onClick={() => setOpen(false)}>
            Login / signup to create your own
          </Link>
        </div>
      )}
    </div>
  );
}
