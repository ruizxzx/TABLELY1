import Link from 'next/link';
import { ArrowRight, Check, ChefHat, LayoutDashboard, QrCode, Smartphone, BarChart3, Clock3, CreditCard, Sparkles, Zap, ShieldCheck, Users, UtensilsCrossed, TrendingUp } from 'lucide-react';
import { Brand, PlatformLogo } from '@/components/Brand';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { PublicFooter } from '@/components/public/PublicFooter';

const features = [
  { title: 'QR ordering', copy: 'Customers scan the table QR and order directly from their phone.', Icon: QrCode },
  { title: 'Kitchen workflow', copy: 'Every order moves through a simple, realtime operational flow.', Icon: ChefHat },
  { title: 'Owner dashboard', copy: 'Orders, tables, menu and sales are organized in one workspace.', Icon: LayoutDashboard },
];

type PublicPlan = {id:string;name:string;price_monthly:number;price_annual:number|null;featured:boolean;items:string[];enterprise?:boolean;description?:string|null};
const fallbackPlans: PublicPlan[] = [
  { id: 'STARTER', name: 'Starter', price_monthly: 799, price_annual: 7990, featured: false, items: ['Digital menu', 'QR ordering', '10 tables', 'Kitchen + order dashboard', 'Pay at counter'] },
  { id: 'GROWTH', name: 'Growth', price_monthly: 1499, price_annual: 14990, featured: true, items: ['Everything in Starter', 'Online restaurant payments', '8 staff', 'Service requests', 'Analytics', 'Custom branding'] },
  { id: 'PRO', name: 'Pro', price_monthly: 2999, price_annual: 29990, featured: false, items: ['Everything in Growth', '3 branches', '75 tables', 'Advanced analytics', 'Advanced permissions', 'Custom domain'] },
  { id: 'ENTERPRISE', name: 'Enterprise', price_monthly: 0, price_annual: null, featured: false, items: ['Custom pricing and rollout', 'Dedicated success support', 'Advanced security and controls', 'Contact our team'] },
];

async function loadPlans() {
  const client = await getSupabaseServerClient();
  if (!client) return { plans: fallbackPlans, marketing: null };
  const [{ data, error }, { data: marketing }] = await Promise.all([client.rpc('get_public_plan_catalog_v2'), client.rpc('get_public_marketing_settings')]);
  if (error || !Array.isArray(data) || data.length === 0) return { plans: fallbackPlans, marketing: null };
  const order = ['STARTER', 'GROWTH', 'PRO', 'ENTERPRISE'];
  return { plans: data.map((p: {id:string;name:string;price_monthly:number;price_annual:number;max_tables:number|null;max_staff:number|null;max_branches:number|null;features?:Record<string,unknown>;description?:string|null}) => ({
    id: p.id, name: p.name, price_monthly: Number(p.price_monthly), price_annual: p.price_annual==null?null:Number(p.price_annual), featured: p.id === 'GROWTH',
    enterprise: p.id === 'ENTERPRISE' || Boolean(p.features?.enterprise_contact),
    description: p.description,
    items: Array.isArray(p.features?.custom_lines) && p.features.custom_lines.length > 0 ? p.features.custom_lines.map(String) : p.id === 'STARTER'
      ? ['Digital menu', 'QR ordering', `${p.max_tables ?? 'Unlimited'} tables`, 'Kitchen + order dashboard', 'Pay at counter']
      : p.id === 'GROWTH'
        ? ['Everything in Starter', 'Online restaurant payments', `${p.max_staff ?? 'Unlimited'} staff`, 'Service requests', 'Analytics', 'Custom branding']
        : p.id === 'ENTERPRISE' ? (Array.isArray(p.features?.custom_lines) ? p.features.custom_lines.map(String) : ['Custom pricing and rollout', 'Dedicated success support', 'Advanced security and controls'])
        : ['Everything in Growth', `${p.max_branches ?? 'Unlimited'} branches`, `${p.max_tables ?? 'Unlimited'} tables`, 'Advanced analytics', 'Advanced permissions', 'Custom domain'],
  })).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)), marketing };
}

function money(value:number|null|undefined){return Number.isFinite(Number(value))?new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(value)):'—';}

export default async function Home() {
  const catalog = await loadPlans();
  const plans = catalog.plans;
  const marketing = catalog.marketing as {hero_kicker?:string;hero_title?:string;hero_description?:string;hero_primary_label?:string;hero_primary_href?:string;hero_secondary_label?:string;hero_secondary_href?:string;features_title?:string;features_description?:string;how_title?:string;how_steps?:Array<{number:string;title:string;copy:string}>} | null;
  return (
    <div className="marketing-page">
      <nav className="marketing-nav">
        <div className="container nav-inner">
          <Brand />
          <div className="desktop-links">
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#how">How it works</a>
            <Link href="/login">Login</Link>
            <Link className="button button-primary" href="/signup">Get started</Link>
          </div>
        </div>
      </nav>

      <section className="hero-section">
        <div className="container hero-grid">
          <div>
            <div className="hero-kicker"><span className="hero-kicker-dot" /> {marketing?.hero_kicker ?? 'BUILT FOR AMBITIOUS RESTAURANTS'}</div>
            <h1>{marketing?.hero_title ?? 'More orders. Less chaos.'}</h1>
            <p className="hero-copy">{marketing?.hero_description ?? 'Tablely gives your restaurant a beautifully simple operating system — from the first QR scan to the final payment.'}</p>
            <div className="button-row">
              <Link href={marketing?.hero_primary_href ?? '/signup'} className="button button-primary">{marketing?.hero_primary_label ?? 'Build your restaurant'} <ArrowRight size={16} /></Link>
              <Link href={marketing?.hero_secondary_href ?? '#how'} className="button button-light">{marketing?.hero_secondary_label ?? 'See how it works'}</Link>
            </div>
            <div className="hero-points">
              {['No customer app required', 'UPI + pay at counter', 'Live kitchen workflow', 'Table-level QR codes'].map((text) => (
                <span key={text}><Check size={15} /> {text}</span>
              ))}
            </div>
            <div className="hero-proof"><div className="avatar-stack"><span>R</span><span>M</span><span>S</span><span>+</span></div><span>Made for teams that care about every table.</span></div>
          </div>

          <div className="hero-dashboard">
            <div className="hero-dashboard-glow" />
            <div className="hero-window">
              <div className="mock-window-bar"><span /><span /><span /><b>TABLELY / LIVE FLOOR</b><Clock3 size={13} /> Open now</div>
              <div className="mock-dashboard-head"><div><span className="eyebrow">GOOD MORNING, OWNER</span><h2>Your restaurant, at a glance.</h2></div><div className="mock-live"><i /> Live</div></div>
              <div className="mock-metrics"><div><span>Today’s revenue</span><strong>₹48,240</strong><small><TrendingUp /> 18.4% vs last week</small></div><div><span>Open orders</span><strong>12</strong><small>3 need attention</small></div><div><span>Tables active</span><strong>18 / 24</strong><small>75% utilization</small></div></div>
              <div className="mock-dashboard-grid"><div className="mock-chart"><div className="mock-card-title"><b>Revenue performance</b><span>7 days</span></div><div className="mock-bars">{[42,58,48,76,64,88,70].map((height, index) => <i key={index} style={{height: `${height}%`}} className={index === 5 ? 'active' : ''} />)}</div><div className="mock-chart-labels"><span>Mon</span><span>Wed</span><span>Fri</span><span>Sun</span></div></div><div className="mock-orders"><div className="mock-card-title"><b>Live orders</b><span className="mock-count">4 new</span></div>{[['#1042','Table 07','Preparing'],['#1041','Table 12','Ready'],['#1040','Table 03','Served']].map(([id, table, status]) => <div className="mock-order" key={id}><span className="mock-order-badge"><UtensilsCrossed size={12}/></span><div><b>{id}</b><small>{table}</small></div><em>{status}</em></div>)}</div></div>
            </div>
            <div className="floating-insight insight-one"><span className="floating-icon orange"><Zap size={15}/></span><div><b>Order accepted</b><small>Table 07 · just now</small></div></div>
            <div className="floating-insight insight-two"><span className="floating-icon green"><BarChart3 size={15}/></span><div><b>Peak hour insight</b><small>7:00 – 9:00 PM</small></div></div>
          </div>
        </div>
      </section>

      <section className="brand-strip"><div className="container brand-strip-inner"><span>ONE SMARTER SHIFT STARTS HERE</span><i /><b><QrCode size={16}/> QR ordering</b><b><ChefHat size={16}/> Kitchen flow</b><b><BarChart3 size={16}/> Better decisions</b><b><CreditCard size={16}/> Faster payments</b></div></section>

      <section className="section" id="features">
        <div className="container">
          <div className="section-intro">
            <div className="eyebrow">ONE OPERATING SYSTEM</div>
            <h2>{marketing?.features_title ?? 'Everything your team needs to run a better shift.'}</h2>
            <p className="section-intro-copy">{marketing?.features_description ?? 'One calm workspace for ordering, kitchen flow, payments and the decisions that move your restaurant forward.'}</p>
          </div>
          <div className="feature-grid">
            {[
              ...features,
              { title: 'Payments that fit', copy: 'Accept UPI, online payments and pay at counter without breaking the flow.', Icon: CreditCard },
              { title: 'Insights that matter', copy: 'See what sells, when you are busiest and where your operation can improve.', Icon: BarChart3 },
              { title: 'Made for your team', copy: 'Owners, managers, kitchen and service staff each get the right view.', Icon: Users },
            ].map(({ title, copy, Icon }) => (
              <article className="surface-card" key={title}>
                <div className="feature-icon"><Icon size={21} /></div>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="story-section">
        <div className="container story-grid">
          <div className="story-copy"><div className="eyebrow">A QUIETER WAY TO RUN SERVICE</div><h2>Your team should focus on <em>hospitality.</em></h2><p>Tablely takes repetitive ordering work off the floor, gives the kitchen a clear queue, and puts the numbers owners need in one calm workspace.</p><div className="story-list"><span><ShieldCheck size={17}/> One source of truth for the whole restaurant</span><span><Sparkles size={17}/> A polished guest experience from scan to receipt</span><span><LayoutDashboard size={17}/> Control every branch as you grow</span></div></div>
          <div className="story-visual"><div className="story-orbit orbit-one" /><div className="story-orbit orbit-two" /><div className="story-center"><PlatformLogo className="story-center-logo" alt="" /><b>One workspace</b><small>for every part of service</small></div><div className="story-chip chip-top"><QrCode size={15}/> Guest ordering</div><div className="story-chip chip-right"><ChefHat size={15}/> Kitchen clarity</div><div className="story-chip chip-bottom"><BarChart3 size={15}/> Owner insight</div></div>
        </div>
      </section>

      <section className="how-section" id="how">
        <div className="container how-grid">
          <div>
            <div className="eyebrow">HOW IT WORKS</div>
            <h2>{marketing?.how_title ?? 'From scan to served in a few simple steps.'}</h2>
          </div>
          <div className="steps">
            {[
              ...(marketing?.how_steps?.length ? marketing.how_steps.map(step => [step.number, step.title, step.copy] as [string,string,string]) : [
              ['01', 'Create restaurant', 'Set up your name, branch, menu and tables.'],
              ['02', 'Generate QR codes', 'Print one unique code for every table.'],
              ['03', 'Receive orders', 'Customers order while the kitchen sees them live.'],
              ['04', 'Serve & complete', 'Move the order through the workflow and close the table.'],
              ]),
            ].map(([number, title, copy]) => (
              <div className="step" key={number}>
                <span>{number}</span>
                <div><h3>{title}</h3><p>{copy}</p></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pricing-section" id="pricing">
        <div className="container">
          <div className="section-intro section-intro-light">
            <div className="eyebrow">PRICING</div>
            <h2>Simple, transparent pricing.</h2>
            <p>Start small. Upgrade when the restaurant actually needs more.</p>
          </div>
          <div className="pricing-grid">
            {plans.map((plan) => (
              <article className={`pricing-card ${plan.featured ? 'featured' : ''}`} key={plan.name}>
                {plan.featured ? <span className="popular">MOST POPULAR</span> : null}
                <h3>{plan.name}</h3>
                {'enterprise' in plan && plan.enterprise ? <><div className="plan-price plan-price-contact">{money(plan.price_monthly > 0 ? plan.price_monthly : 10000)}<span>+</span></div><div className="enterprise-price-note">* Final pricing is based on your restaurant group’s requirements.</div></> : <><div className="plan-price">{money(plan.price_monthly)}<span>/month</span></div><div className="muted">or {money(plan.price_annual)}/year</div></>}
                <div className="plan-list">{plan.items.map((item) => <div key={item}><Check size={14} />{item}</div>)}</div>
                <Link href={'enterprise' in plan && plan.enterprise ? '/contact?plan=enterprise' : '/signup'} className="button button-primary button-full">{'enterprise' in plan && plan.enterprise ? 'Contact our team' : 'Get started'}</Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}
