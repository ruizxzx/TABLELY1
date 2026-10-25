# TABLELY BUILD 35 — RESTAURANT-MANAGED PICKUP & DELIVERY (ONLINE ORDERING & FULFILLMENT)

## Executive Summary
Build 35 expands TABLELY from dine-in QR ordering to full restaurant-managed online ordering and fulfillment. Restaurants can now accept online orders through a dedicated, public storefront at `/r/[restaurant]/order`, offer Pickup and Delivery with customizable delivery zones and packaging fees, dispatch orders via an internal delivery workspace (`/delivery`), assign in-house delivery staff or riders (`/delivery/my-orders`), and track order fulfillment live using OTP and pickup code handoffs.

---

## 1. Architecture & Schema Changes

### 1.1 Database Migration
- **File**: `supabase/migrations/20261026010000_build35_1_fulfillment_foundation.sql`
- **Forward-Only, Additive**: Safe migration strictly ordered after Build 34 without altering prior historical files.

### 1.2 Table Alterations: Nullable `table_id` with Fulfillment Constraint
- `public.orders`: `table_id` is made nullable to allow tableless pickup and delivery orders.
- Check constraint `orders_table_fulfillment_check` guarantees:
  - `(fulfillment_type = 'DINE_IN' AND table_id IS NOT NULL)`
  - `(fulfillment_type IN ('PICKUP', 'DELIVERY') AND table_id IS NULL)`
- `public.payment_attempts`: `table_id` is made nullable.
- Trigger updates:
  - `build17_attach_order_session`: Bypasses table session lookup when `new.table_id IS NULL`.
  - `build17_orders_sync_table_trigger`: Guards table operational state updates when `table_id IS NULL`.

### 1.3 New Tables
1. **`public.branch_ordering_settings`**:
   - Stores branch-specific pickup and delivery enablement, operating hours, slot intervals (`slot_interval_minutes`), max orders per slot, packaging charges (`pickup_packaging_fee`, `delivery_packaging_fee`), minimum order amount, and auto-acceptance flags.
2. **`public.delivery_zones`**:
   - Defines geographical delivery coverage by PIN code list or polygon coordinates.
   - Enforces minimum order amount, base delivery fee, per-km fees, and optional free delivery thresholds.
3. **`public.order_fulfillment_details`**:
   - 1:1 link with `public.orders`.
   - Records pickup codes (4 digits) or delivery OTPs (4 digits).
   - Captures delivery address, GPS coordinates, assigned rider (`assigned_staff_id`), dispatch time, and collection milestones (`dispatched_at`, `delivered_at`, `picked_up_at`).
4. **`public.order_fulfillment_events`**:
   - Append-only audit trail capturing every state transition (`WAITING_FOR_DRIVER`, `DISPATCHED`, `DELIVERED`, `PICKED_UP`, `DELIVERY_FAILED`) with actor and metadata.

### 1.4 Staff Permissions
Nine dedicated fine-grained permissions seeded into `staff_permissions`:
1. `VIEW_ONLINE_ORDERS`: View online pickup/delivery queues.
2. `MANAGE_ONLINE_ORDERING`: Configure storefront settings, packaging fees, and operating hours.
3. `MANAGE_PICKUP`: Mark pickup orders ready and confirm customer pickup handoff.
4. `VIEW_DELIVERY`: Access the dispatch management board (`/delivery`).
5. `MANAGE_DELIVERY`: Manage riders, override OTPs, and cancel deliveries.
6. `ASSIGN_DELIVERY`: Assign delivery tasks to available in-house riders.
7. `UPDATE_DELIVERY_STATUS`: Update order status from rider mobile workspace.
8. `COLLECT_DELIVERY_PAYMENT`: Confirm Cash-on-Delivery (COD) or UPI on delivery.
9. `VIEW_DELIVERY_REPORTS`: View fulfillment speed, fee collections, and delivery performance.

---

## 2. Server-Side RPC Functions

1. **`get_public_storefront_context(p_restaurant_slug, p_branch_id)`**:
   - Returns public storefront configuration, branding, active branches, operating hours, pickup/delivery enablement, packaging fees, and delivery zones.
2. **`get_public_menu_for_branch(p_branch_id)`**:
   - Retrieves public menu items, categories, variants, and addons with current stock status.
3. **`preview_public_fulfillment_checkout(...)`**:
   - Server-authoritative checkout calculation:
     - Reuses `build16_calculate_cart` for item prices and modifiers.
     - Reuses `build18_validate_coupon` for discount calculations.
     - Validates PIN code against `delivery_zones`.
     - Calculates packaging fees and delivery charges.
     - Applies free delivery thresholds.
     - Returns subtotal, taxes, charges, discount, and total.
4. **`create_public_fulfillment_order(...)`**:
   - Idempotently creates order, order items, and fulfillment details.
   - Generates random 24-byte tracking token, 4-digit pickup code or 4-digit delivery OTP.
5. **`get_public_fulfillment_order(p_tracking_token)`**:
   - Redacts sensitive payment keys and internal staff notes.
   - Returns live tracking state, ETAs, address snapshot, and order receipt.
6. **`fulfillment_assign_rider(p_order_id, p_staff_id)`**:
   - Assigns branch staff/rider to a delivery order.
7. **`fulfillment_dispatch_delivery(p_order_id, p_estimated_minutes)`**:
   - Transitions fulfillment to `OUT_FOR_DELIVERY`.
8. **`fulfillment_confirm_delivered(p_order_id, p_delivery_otp, p_manager_override)`**:
   - Requires correct 4-digit customer OTP or manager override.
   - Marks order `DELIVERED` and `COMPLETED`.
9. **`fulfillment_confirm_pickup(p_order_id, p_pickup_code, p_manager_override)`**:
   - Validates pickup code or manager override, marking order `PICKED_UP`.
10. **`fulfillment_collect_payment(p_order_id, p_method, p_amount)`**:
    - Marks COD or UPI payment collected by rider.
11. **`fulfillment_list_my_deliveries()`**:
    - Lists active and completed deliveries for the currently logged-in rider.
12. **`fulfillment_list_branch_orders(p_branch_id, p_type)`**:
    - Feeds the `/delivery` dispatch management board.
13. **`fulfillment_get_reports(p_branch_id, p_from, p_to)`**:
    - Computes average prep time, average delivery time, fees collected, and failed delivery count.

---

## 3. User Interfaces & Routes

### 3.1 Customer Storefront
- `/r/[restaurant]/order`: Main restaurant storefront with multi-branch selector, pickup/delivery toggle, PIN code serviceability check, category filter, search, customization modal, and floating cart bar.
- `/r/[restaurant]/order/[branch]`: Branch-specific storefront landing.
- `/r/[restaurant]/order/checkout`: Step-by-step checkout with address inputs, delivery instructions, time slot picker (ASAP vs Scheduled), coupon applicator, payment method selector (Online, COD, UPI on Delivery, Pay at Counter), and live price breakdown.
- `/r/[restaurant]/order/track/[token]`: Customer live order tracking screen with status timeline, 4-digit pickup code / delivery OTP, ETA badge, directions link, and Realtime status sync.

### 3.2 Restaurant Dispatch & Management
- `/delivery`: Dispatch management board with fulfillment tabs (`All`, `Waiting for Driver`, `Dispatched`, `Ready for Pickup`, `Completed`, `Failed`), rider assigner modal, and OTP confirmation modal.
- `/delivery/my-orders`: Mobile-friendly delivery rider workspace with customer contact button, Google Maps navigation button, OTP submission, and COD collection modal.
- `/settings/online-ordering`: Comprehensive online ordering configuration for hours, packaging fees, minimum order values, auto-accept toggles, and Delivery Zones CRUD manager.
- `/orders` & `/kitchen`: Enhanced to display `PICKUP` and `DELIVERY` channel badges and handle tableless orders gracefully.
