/**
 * Public collection ceilings are abuse/SSR safety guards, not creator display limits.
 * Creator-facing displayLimit values are applied separately in BentoBlock.
 */
export const PUBLIC_CONTENT_SAFETY_LIMITS = {
  bentoBlocks: 120,
  bentoGalleryImages: 100,
  bentoSocials: 100,
  bentoCollectionItems: 250,
  storeProducts: 500,
  storeBundles: 200,
} as const;
