import Link from 'next/link';

export default function TermsPage() {
  return <main className="legal-page"><div className="legal-panel">
    <Link href="/" className="back-link">← Back to Tablely</Link>
    <div className="eyebrow">TABLELY</div>
    <h1>Terms and conditions</h1>
    <p className="legal-updated">Last updated: 18 September 2026</p>
    <p>These terms govern use of Tablely by restaurant organizations, staff, and customers. Tablely is a software service; each restaurant remains responsible for its menu, pricing, taxes, fulfillment, refunds, and customer communications.</p>
    <h2>Restaurant accounts</h2>
    <p>Organizations must provide accurate account information, protect staff access, and use branch permissions appropriately. Account owners are responsible for activity performed through their organization.</p>
    <h2>Customer ordering and payments</h2>
    <p>Customers must provide accurate ordering details and use the payment method selected at checkout. Orders, payment states, cancellations, and Pay-Later eligibility are governed by the restaurant’s configured operational rules.</p>
    <h2>Acceptable use</h2>
    <p>Do not misuse the service, attempt unauthorized access, interfere with payment or order processing, submit abusive content, or access another organization’s data.</p>
    <h2>Subscriptions and suspension</h2>
    <p>Restaurant subscriptions and plan entitlements are subject to the selected plan and billing records. Tablely may restrict or suspend access for abuse, security concerns, non-payment, or violation of these terms.</p>
    <h2>Content and responsibility</h2>
    <p>Restaurants are responsible for menu content, prices, availability, legal compliance, and customer service. Customers are responsible for reviewing their order before submission.</p>
    <h2>Service limitations</h2>
    <p>Tablely is provided on an availability basis. We work to keep the service reliable, but cannot guarantee uninterrupted access or accept responsibility for events outside reasonable control.</p>
    <h2>Contact</h2>
    <p>For support, contact the Tablely administrator or the organization operating your restaurant workspace.</p>
  </div></main>;
}
