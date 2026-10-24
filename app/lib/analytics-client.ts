const VISITOR_KEY = 'tablely_visitor_id';
const SESSION_KEY = 'tablely_session_id';
const LEGACY_VISITOR_KEYS = ['instaly_visitor_id', 'sellora_visitor_id'];
const LEGACY_SESSION_KEYS = ['instaly_session_id', 'sellora_session_id'];

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function read(storage: StorageLike | null, key: string) {
  try { return storage?.getItem(key) || null; } catch { return null; }
}

function write(storage: StorageLike | null, key: string, value: string) {
  try { storage?.setItem(key, value); } catch {}
}

function newId() {
  try { return crypto.randomUUID(); } catch { return `tablely-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

export function getAnalyticsIdentity() {
  const legacyVisitor = LEGACY_VISITOR_KEYS.map(key => read(window.localStorage, key)).find(Boolean);
  const visitorId = read(window.localStorage, VISITOR_KEY) || legacyVisitor || newId();
  write(window.localStorage, VISITOR_KEY, visitorId);

  const currentSession = read(window.sessionStorage, SESSION_KEY);
  const legacySession = LEGACY_SESSION_KEYS
    .flatMap(key => [read(window.sessionStorage, key), read(window.localStorage, key)])
    .find(Boolean);
  const sessionId = currentSession || legacySession || newId();
  write(window.sessionStorage, SESSION_KEY, sessionId);

  return { visitorId, sessionId };
}

export function getAnalyticsAttribution() {
  const params = new URLSearchParams(window.location.search);
  return {
    utmSource: params.get('utm_source'),
    utmMedium: params.get('utm_medium'),
    utmCampaign: params.get('utm_campaign'),
    utmContent: params.get('utm_content'),
    utmTerm: params.get('utm_term'),
    referrer: document.referrer || null,
  };
}

export function createAnalyticsEventId(prefix = 'event') {
  return `${prefix}:${newId()}`;
}
