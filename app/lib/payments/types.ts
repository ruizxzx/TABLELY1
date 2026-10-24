export type PaymentModel='creator_connected'|'platform_merchant'|'marketplace';
export type PaymentTransactionStatus='initializing'|'pending'|'processing'|'succeeded'|'failed'|'cancelled';
export type OrderStatus='created'|'pending'|'paid'|'failed'|'cancelled'|'refunded'|'partially_refunded'|'disputed';
export type ProviderAuth={accessToken?:string;publicToken?:string;apiKeyId?:string;apiKeySecret?:string;webhookSecret?:string;authMode?:'oauth'|'api_credentials'|'platform'};
export type CreatePaymentInput={amountMinor:number;currency:string;receipt:string;notes:Record<string,string>};
export type CreatePaymentResult={provider:string;providerOrderId:string;amountMinor:number;currency:string};
export type ProviderPayment={id:string;orderId:string;amountMinor:number;currency:string;status:string;feeMinor:number;taxMinor:number;raw:unknown};
export type VerificationInput={providerOrderId:string;paymentId:string;signature:string};
export type WebhookEvent={providerEventId:string;eventType:string;paymentId:string|null;providerOrderId:string|null;status:PaymentTransactionStatus|null;raw:unknown};
export interface PaymentProvider{readonly name:string;createPayment(input:CreatePaymentInput,auth?:ProviderAuth):Promise<CreatePaymentResult>;getPayment(paymentId:string,auth?:ProviderAuth):Promise<ProviderPayment>;verifyPayment(input:VerificationInput,expectedOrderId:string,auth?:ProviderAuth):boolean;validateWebhook(rawBody:string,signature:string|null,secretOverride?:string):boolean;parseWebhook(rawBody:string,headers:Headers):WebhookEvent;refundPayment(paymentId:string,amountMinor?:number,auth?:ProviderAuth):Promise<unknown>;publicKeyId(auth?:ProviderAuth):string;}
