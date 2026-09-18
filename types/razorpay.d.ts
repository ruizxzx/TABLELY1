export {};

declare global {
  interface RazorpayInstance {
    open: () => void;
    on: (event: string, handler: (payload: unknown) => void) => void;
  }

  interface RazorpayConstructor {
    new (options: Record<string, unknown>): RazorpayInstance;
  }

  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}
