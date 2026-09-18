#!/usr/bin/env node

function getArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const baseUrl = getArg('base-url');
const orderId = getArg('order-id');
const trackingToken = getArg('tracking-token');
const email = getArg('email');

if (!baseUrl || !orderId || !trackingToken || !email) {
  console.error(
    'Usage: node scripts/phase5-verify-web-order-email.mjs --base-url <url> --order-id <uuid> --tracking-token <token> --email <address>',
  );
  process.exit(2);
}

const endpoint = `${baseUrl.replace(/\/$/, '')}/api/customer/order-email-notifications`;

let response;
try {
  response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId, trackingToken, email }),
  });
} catch (error) {
  console.error('Request failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const body = await response.json().catch(() => ({}));

if (!response.ok) {
  console.error(`HTTP ${response.status}`);
  console.error(body?.error ?? 'The subscription API returned an error.');
  process.exit(1);
}

console.log('PASS: Phase 2 order-email subscription endpoint accepted the request.');
console.log('Response:', JSON.stringify(body));
