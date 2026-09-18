# Customer checkout authentication fix

## Root cause
`CustomerCheckoutClient` called `saveAuthenticatedCustomerContact()` for every checkout method. That helper called `supabase.auth.getUser()` and threw when there was no session, so guest PAY_AT_COUNTER and PAY_NOW checkout stopped with `Auth session missing!`.

## Intended behavior
- PAY_AT_COUNTER: guest checkout allowed.
- PAY_NOW / Razorpay: guest checkout allowed.
- PAY_LATER / Pay After Delivery: authentication remains required through `requireCustomerAuth()` and the existing `open_pay_later_session()` server guard.
- Signed-in customers may still have their profile contact details synchronized.

## Fix
Profile synchronization is now best-effort. An absent session, profile lookup error, or profile-sync error cannot block PAY_AT_COUNTER/PAY_NOW. The order still sends the explicitly entered customer name and phone to the server.

## Preserved
No database schema or ordering/payment method logic was changed.
