# Sellora Business Model Update — September 2026

## Canonical model

Sellora is a subscription SaaS platform for independent creators.

- Creators use their own payment accounts for product sales.
- Sellora does not take a transaction commission from creator product sales under the new model.
- Sellora earns recurring subscription revenue from creator plans.
- Creator sale funds are not held in a Sellora wallet and do not create new Sellora payout obligations.
- Existing platform-fee, seller-net, ledger, and payout records are retained as legacy historical data.

## Current UI state

The site now communicates the intended subscription model without claiming that creator payment-account OAuth or live recurring subscription billing is already configured. Areas that depend on those integrations show `Setup required` rather than a fake connected/active state.

## Transition rule

Until the approved creator payment-account connection flow and subscription billing are implemented, existing platform-merchant/test payment infrastructure remains a legacy/test implementation. New production creator-connected settlement must not be represented as live.
