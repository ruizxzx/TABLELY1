export function getAppBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const deploymentHost = process.env.VERCEL_URL?.trim();
  if (deploymentHost) return `https://${deploymentHost.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Set NEXT_PUBLIC_APP_URL or VERCEL_URL for production links.');
  }

  return 'http://localhost:3001';
}

export function getClientAppBaseUrl() {
  return getAppBaseUrl();
}
