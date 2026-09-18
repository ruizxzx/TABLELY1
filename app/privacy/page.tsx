import Link from 'next/link';

export default function PrivacyPage() {
  return <main className="legal-page"><div className="legal-panel">
    <Link href="/" className="back-link">← Back to Tablely</Link>
    <div className="eyebrow">TABLELY</div>
    <h1>Privacy policy</h1>
    <p className="legal-updated">Last updated: 18 September 2026</p>
    <p>Tablely helps restaurants manage QR ordering, orders, payments, staff operations, and customer accounts. This policy explains the information used to provide those services.</p>
    <h2>Information we use</h2>
    <p>Depending on how you use Tablely, we may process account details, restaurant and staff details, customer profile information, table and visit context, order and payment records, support messages, and technical information needed to keep the service secure.</p>
    <h2>How information is used</h2>
    <p>We use this information to authenticate users, process orders and payments, maintain restaurant operations, provide customer order history and receipts, prevent fraud, respond to support requests, and improve reliability.</p>
    <h2>Payments and providers</h2>
    <p>Online payments are handled through the configured payment provider. Tablely records payment status and transaction references needed for reconciliation; full payment credentials are not stored by Tablely.</p>
    <h2>Access and retention</h2>
    <p>Restaurant data is scoped to the relevant organization and authorized branches. Customer data is scoped to the authenticated customer and their restaurant relationships. Financial, order, security, and audit records may need to be retained even when an account is deleted.</p>
    <h2>Your choices</h2>
    <p>You may request access, correction, or deletion of eligible account information. Some historical records may be retained or anonymized when deletion would compromise financial, legal, or security obligations.</p>
    <h2>Contact</h2>
    <p>For privacy questions or requests, contact the Tablely administrator or the organization that operates your restaurant account.</p>
  </div></main>;
}
