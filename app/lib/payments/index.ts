import { RazorpayProvider } from './razorpay';
import type { PaymentModel } from './types';
export function getConfiguredPaymentModel():PaymentModel{const value=process.env.SELLORA_PAYMENT_MODEL||'creator_connected';return value==='platform_merchant'||value==='marketplace'||value==='creator_connected'?value:'creator_connected';}
let provider:RazorpayProvider|null=null;
export function getRazorpayProvider(){if(!provider)provider=new RazorpayProvider();return provider;}
