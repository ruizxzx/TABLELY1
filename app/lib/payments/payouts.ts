export type PayoutRequest = {
  amountMinor: number;
  currency: string;
  providerAccountId?: string | null;
  reference: string;
  metadata?: Record<string, string>;
};

export type PayoutResult = {
  supported: boolean;
  provider: string;
  providerPayoutId?: string;
  status: 'pending' | 'processing' | 'paid' | 'failed';
  message?: string;
};

export interface PayoutProvider {
  readonly name: string;
  isSupported(): boolean;
  createPayout(input: PayoutRequest): Promise<PayoutResult>;
  getPayout(providerPayoutId: string): Promise<PayoutResult>;
}

export class UnsupportedPayoutProvider implements PayoutProvider {
  readonly name = 'unsupported';
  isSupported() { return false; }
  async createPayout(_: PayoutRequest): Promise<PayoutResult> {
    return { supported: false, provider: this.name, status: 'failed', message: 'Creator settlement is not enabled for the configured payment arrangement.' };
  }
  async getPayout(_: string): Promise<PayoutResult> {
    return { supported: false, provider: this.name, status: 'failed', message: 'Creator settlement is not enabled for the configured payment arrangement.' };
  }
}

export function getConfiguredPayoutProvider(): PayoutProvider {
  // Deliberately unsupported until the configured payment provider/account explicitly
  // supports creator settlement for TABLELY's approved business model.
  return new UnsupportedPayoutProvider();
}
