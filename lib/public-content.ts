export type ContactContent = {
  eyebrow: string;
  title: string;
  description: string;
  email: string;
  location: string;
  response_time: string;
  form_title: string;
  form_description: string;
  success_message: string;
  form_cta: string;
};

export type VisionContent = {
  eyebrow: string;
  title: string;
  intro: string;
  vision_heading: string;
  vision_body: string;
  problem_heading: string;
  problem_items: string[];
  idea_heading: string;
  idea_body: string;
  customer_flow: string[];
  restaurant_flow: string[];
  build_heading: string;
  build_body: string;
  principles: Array<{ title: string; copy: string }>;
  founder: { name: string; title: string; bio: string; quote: string; image_url: string | null; image_path: string | null };
};

export type LegalContent = {
  title: string;
  intro: string;
  sections: Array<{ heading: string; body: string }>;
};

export const defaultContact: ContactContent = {
  eyebrow: 'TABLELY ENTERPRISE',
  title: 'Let’s build the right setup.',
  description: 'Tell us about your restaurants or restaurant group and our team will get in touch within 24 hours.',
  email: 'krishsarkar456@gmail.com',
  location: 'India, Kolkata',
  response_time: 'Within 24 hours',
  form_title: 'Start a conversation',
  form_description: 'Tell us what you are building, how many locations you have, and what you need from TABLELY.',
  success_message: 'Thanks for reaching out. Your message has been received. Our team will get in touch within 24 hours.',
  form_cta: 'Send inquiry',
};

export const defaultVision: VisionContent = {
  eyebrow: 'THE VISION BEHIND TABLELY',
  title: 'Building a simpler way for restaurants to operate.',
  intro: 'TABLELY is being built around a simple idea: technology should remove unnecessary friction from the restaurant experience instead of adding another complicated system for staff and customers to manage.',
  vision_heading: 'My vision',
  vision_body: 'Make restaurant technology simpler to adopt, easier to understand, and useful enough to become part of the everyday shift.',
  problem_heading: 'The problem',
  problem_items: ['Manual ordering creates avoidable work.','Restaurant teams often work across disconnected tools.','Slow communication between floor and kitchen creates friction.','Payment, customer, and operational information can become fragmented.','Smaller restaurants should not need enterprise-level complexity to access useful technology.'],
  idea_heading: 'The idea',
  idea_body: 'One connected system where the customer experience and restaurant operation support each other from the first QR scan to the final payment and feedback.',
  customer_flow: ['Menu','Order','Kitchen','Service','Payment','Feedback'],
  restaurant_flow: ['Operations','Staff','Customers','Payments','Analytics'],
  build_heading: 'What I want to build',
  build_body: 'A long-term restaurant platform that starts with QR ordering and grows into a practical operating system for restaurants of every size.',
  principles: [
    { title: 'Simple', copy: 'Useful without unnecessary complexity.' },
    { title: 'Useful', copy: 'Every feature should solve a real restaurant problem.' },
    { title: 'Fast', copy: 'The system should keep the shift moving.' },
    { title: 'Transparent', copy: 'Owners should understand what the platform is doing.' },
    { title: 'Scalable', copy: 'A small restaurant should be able to grow without replacing its system.' },
  ],
  founder: { name: 'Krish Sarkar', title: 'Founder / Builder', bio: 'Building TABLELY with a focus on making restaurant technology more approachable, connected, and practical.', quote: 'Build the system restaurants actually need.', image_url: null, image_path: null },
};

export const defaultPrivacy: LegalContent = {
  title: 'Privacy policy',
  intro: 'Tablely helps restaurants manage QR ordering, orders, payments, staff operations, and customer accounts. This policy explains the information used to provide those services.',
  sections: [
    { heading: 'Information we use', body: 'Depending on how you use Tablely, we may process account details, restaurant and staff details, customer profile information, table and visit context, order and payment records, support messages, and technical information needed to keep the service secure.' },
    { heading: 'How information is used', body: 'We use this information to authenticate users, process orders and payments, maintain restaurant operations, provide customer order history and receipts, prevent fraud, respond to support requests, and improve reliability.' },
    { heading: 'Payments and providers', body: 'Online payments are handled through the configured payment provider. Tablely records payment status and transaction references needed for reconciliation; full payment credentials are not stored by Tablely.' },
    { heading: 'Access and retention', body: 'Restaurant data is scoped to the relevant organization and authorized branches. Customer data is scoped to the authenticated customer and their restaurant relationships. Financial, order, security, and audit records may need to be retained even when an account is deleted.' },
    { heading: 'Your choices', body: 'You may request access, correction, or deletion of eligible account information. Some historical records may be retained or anonymized when deletion would compromise financial, legal, or security obligations.' },
    { heading: 'Contact', body: 'For privacy questions or requests, contact the Tablely administrator at krishsarkar456@gmail.com.' },
  ],
};

export const defaultTerms: LegalContent = {
  title: 'Terms and conditions',
  intro: 'These terms govern use of Tablely by restaurant organizations, staff, and customers. Tablely is a software service; each restaurant remains responsible for its menu, pricing, taxes, fulfillment, refunds, and customer communications.',
  sections: [
    { heading: 'Restaurant accounts', body: 'Organizations must provide accurate account information, protect staff access, and use branch permissions appropriately. Account owners are responsible for activity performed through their organization.' },
    { heading: 'Customer ordering and payments', body: 'Customers must provide accurate ordering details and use the payment method selected at checkout. Orders, payment states, cancellations, and Pay-Later eligibility are governed by the restaurant’s configured operational rules.' },
    { heading: 'Acceptable use', body: 'Do not misuse the service, attempt unauthorized access, interfere with payment or order processing, submit abusive content, or access another organization’s data.' },
    { heading: 'Subscriptions and suspension', body: 'Restaurant subscriptions and plan entitlements are subject to the selected plan and billing records. Tablely may restrict or suspend access for abuse, security concerns, non-payment, or violation of these terms.' },
    { heading: 'Content and responsibility', body: 'Restaurants are responsible for menu content, prices, availability, legal compliance, and customer service. Customers are responsible for reviewing their order before submission.' },
    { heading: 'Service limitations', body: 'Tablely is provided on an availability basis. We work to keep the service reliable, but cannot guarantee uninterrupted access or accept responsibility for events outside reasonable control.' },
    { heading: 'Contact', body: 'For support, contact the Tablely administrator at krishsarkar456@gmail.com or the organization operating your restaurant workspace.' },
  ],
};

export const defaultCancellationRefund: LegalContent = {
  title: 'Cancellation & Refund Policy',
  intro: 'Effective Date: 18 September 2026\n\nTABLELY provides restaurant technology and SaaS services, including digital ordering, table management, menu management, payment-related tools, customer management, and related software features.',
  sections: [
    { heading: '1. Subscription Cancellation', body: 'Customers may cancel their TABLELY subscription at any time through their TABLELY account or by contacting our support team.\n\nCancellation will prevent future subscription renewals. The subscription will normally remain active until the end of the current paid billing period.' },
    { heading: '2. Refunds', body: 'Subscription fees are generally non-refundable once a billing period has started, except in the following circumstances:\n\n- A duplicate payment was charged.\n- A payment was charged incorrectly due to a technical error.\n- TABLELY authorizes a refund at its discretion where appropriate.\n- A refund is required under applicable law.\n\nApproved refunds will normally be processed back to the original payment method used for the transaction. The time taken for the refunded amount to appear in the customer\u2019s account may depend on the customer\u2019s bank or payment provider.' },
    { heading: '3. Failed or Duplicate Payments', body: 'If a payment is deducted but the TABLELY service is not activated because of a payment-processing failure, the transaction will be reviewed and any amount incorrectly charged will be refunded or otherwise reconciled.\n\nDuplicate transactions will be eligible for refund after verification.' },
    { heading: '4. How to Request a Refund', body: 'To request a cancellation or refund, contact:\n\nEmail: support@tablely.in\n\nPlease provide:\n\n- Account name\n- Registered email address\n- Transaction/payment reference\n- Date of payment\n- Reason for the request\n\nWe may request additional information to verify the transaction.' },
    { heading: '5. Processing Time', body: 'Once a refund is approved, TABLELY will initiate the refund to the original payment method. The final credit time depends on the payment gateway, bank, or card issuer.' },
    { heading: '6. Contact', body: 'For cancellation, refund, or payment-related questions:\n\nTABLELY Support\nWebsite: https://www.tablely.in/\nEmail: support@tablely.in' },
  ],
};

const safeString = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value : fallback;
const safeStringArray = (value: unknown, fallback: string[]) => Array.isArray(value) ? value.map(String).map(x => x.trim()).filter(Boolean) : fallback;

export function normalizeContact(input: Partial<ContactContent>): ContactContent {
  return {
    eyebrow: safeString(input.eyebrow, defaultContact.eyebrow), title: safeString(input.title, defaultContact.title), description: safeString(input.description, defaultContact.description),
    email: safeString(input.email, defaultContact.email), location: safeString(input.location, defaultContact.location), response_time: safeString(input.response_time, defaultContact.response_time),
    form_title: safeString(input.form_title, defaultContact.form_title), form_description: safeString(input.form_description, defaultContact.form_description), success_message: safeString(input.success_message, defaultContact.success_message), form_cta: safeString(input.form_cta, defaultContact.form_cta),
  };
}

export function normalizeVision(input: Partial<VisionContent>): VisionContent {
  const founder = input.founder ?? defaultVision.founder;
  return {
    eyebrow: safeString(input.eyebrow, defaultVision.eyebrow), title: safeString(input.title, defaultVision.title), intro: safeString(input.intro, defaultVision.intro),
    vision_heading: safeString(input.vision_heading, defaultVision.vision_heading), vision_body: safeString(input.vision_body, defaultVision.vision_body),
    problem_heading: safeString(input.problem_heading, defaultVision.problem_heading), problem_items: safeStringArray(input.problem_items, defaultVision.problem_items),
    idea_heading: safeString(input.idea_heading, defaultVision.idea_heading), idea_body: safeString(input.idea_body, defaultVision.idea_body),
    customer_flow: safeStringArray(input.customer_flow, defaultVision.customer_flow), restaurant_flow: safeStringArray(input.restaurant_flow, defaultVision.restaurant_flow),
    build_heading: safeString(input.build_heading, defaultVision.build_heading), build_body: safeString(input.build_body, defaultVision.build_body),
    principles: Array.isArray(input.principles) && input.principles.length ? input.principles.map(item => ({ title: safeString(item?.title, 'Principle'), copy: safeString(item?.copy, '') })).filter(item => item.copy) : defaultVision.principles,
    founder: { name: safeString(founder.name, defaultVision.founder.name), title: safeString(founder.title, defaultVision.founder.title), bio: safeString(founder.bio, defaultVision.founder.bio), quote: safeString(founder.quote, defaultVision.founder.quote), image_url: typeof founder.image_url === 'string' ? founder.image_url : null, image_path: typeof founder.image_path === 'string' ? founder.image_path : null },
  };
}

export function normalizeLegal(input: Partial<LegalContent>, fallback: LegalContent): LegalContent {
  return {
    title: safeString(input.title, fallback.title),
    intro: safeString(input.intro, fallback.intro),
    sections: Array.isArray(input.sections) && input.sections.length ? input.sections.map(item => ({ heading: safeString(item?.heading, 'Section'), body: safeString(item?.body, '') })).filter(item => item.body) : fallback.sections,
  };
}
