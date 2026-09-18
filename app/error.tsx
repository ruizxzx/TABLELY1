'use client';
import { useEffect } from 'react';
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[Tablely] unhandled application error', error); }, [error]);
  return <main className="customer-page"><div className="customer-error"><h1>Something went wrong</h1><p>Tablely hit an unexpected error. Your data was not intentionally changed by this screen.</p><button className="customer-primary-button" onClick={() => reset()}>Try again</button></div></main>;
}
