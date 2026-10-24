export type MenuTranslationLanguage = 'hi' | 'bn';

type TranslationProgress = (language: MenuTranslationLanguage, remaining: number) => void;

type SyncOptions = {
  refreshAll?: boolean;
  onProgress?: TranslationProgress;
};

export async function syncMenuTranslations(branchId: string, options: SyncOptions = {}) {
  const refreshAll = options.refreshAll ?? false;
  let translated = 0;

  for (const language of ['hi', 'bn'] as const) {
    let remaining = 1;
    let cursor = 0;
    let batches = 0;

    while (remaining > 0) {
      if (batches >= 500) throw new Error('Translation is taking too long. Retry the sync from the menu page.');
      const response = await fetch('/api/menu/translations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          branchId,
          language,
          ...(refreshAll ? { refreshAll: true, cursor } : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not save menu translations.');

      remaining = Number(body.remaining ?? 0);
      translated += Number(body.translated ?? 0);
      batches += 1;
      options.onProgress?.(language, remaining);

      if (refreshAll && remaining > 0) {
        const nextCursor = Number(body.nextCursor);
        if (!Number.isInteger(nextCursor) || nextCursor <= cursor) {
          throw new Error('Translation sync did not advance. Retry from the menu page.');
        }
        cursor = nextCursor;
      }
    }
  }

  return { translated };
}
