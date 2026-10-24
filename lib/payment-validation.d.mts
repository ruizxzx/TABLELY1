export interface RazorpayPaymentSnapshot {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  captured?: boolean;
  method?: string;
}
export interface ExpectedRazorpayPayment {
  orderId: string;
  paymentId?: string;
  amountInPaise: number;
  currency?: string;
}
export function toRazorpayPaise(amount: number | string): number | null;
export function matchesRazorpayPayment(payment: RazorpayPaymentSnapshot | null | undefined, expected: ExpectedRazorpayPayment): boolean;
export function isRazorpayPaymentCaptured(payment: RazorpayPaymentSnapshot | null | undefined): boolean;
