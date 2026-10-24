import type { Metadata } from 'next';
import PartnerRegistration from './registration';

export const metadata: Metadata = { title: 'Become a TABLELY Partner', description: 'Refer restaurants to TABLELY and track verified referrals and commissions.' };

export default function PartnersPage() {
  return <main className="partner-public-page">
    <section className="partner-public-hero"><div className="partner-public-hero-inner"><span className="eyebrow">TABLELY PARTNER NETWORK</span><h1>Grow local restaurants.<br/><em>Earn for every result.</em></h1><p>Get a permanent referral link, see restaurant verification progress and track plan based commissions from successful subscription payments.</p><div className="button-row"><a className="button button-primary" href="#partner-apply">Apply to become a partner</a><a className="button button-light" href="/partners/login">Partner sign in</a></div><small>Every partner application is reviewed before referrals become commission eligible.</small></div><div className="partner-hero-stat"><strong>30 days</strong><span>first party referral attribution</span><strong>Plan based</strong><span>commission snapshots on each payment</span><strong>Manual payout</strong><span>reviewed and paid by TABLELY</span></div></section>
    <section className="partner-how"><div><span className="eyebrow">SIMPLE, TRACEABLE, FAIR</span><h2>From introduction to payout.</h2></div><div className="partner-how-grid"><article><b>01</b><h3>Apply and verify</h3><p>Confirm your email, accept the partner terms and wait for account approval.</p></article><article><b>02</b><h3>Share your link</h3><p>Approved partners get a permanent link. Clicks are tracked for 30 days and attached at restaurant onboarding.</p></article><article><b>03</b><h3>We verify the business</h3><p>Duplicate checks flag conflicts for review. A partner link alone never proves a restaurant is genuine.</p></article><article><b>04</b><h3>Earn after payment</h3><p>Successful subscription payments generate a rate snapshot based on the plan billed. Refunds create ledger reversals.</p></article></div></section>
    <section id="partner-apply" className="partner-apply-section"><PartnerRegistration/></section>
    <section className="partner-terms"><h2>Clear partner rules</h2><ul><li>Free trials do not earn commission.</li><li>Existing restaurants cannot be claimed retroactively.</li><li>Historical commission rates stay fixed when plans or rates change.</li><li>TABLELY approves and records all manual payouts; partners cannot mark earnings paid.</li></ul></section>
  </main>;
}
