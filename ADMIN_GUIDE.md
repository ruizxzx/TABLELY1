# TABLELY Admin Guide — Build 11

## Platform admin

Super Admin access is independent from restaurant roles and is controlled by `platform_admins`.

A test account may simultaneously be a platform admin and the owner of a restaurant workspace. These permissions must remain separate.

## Plan catalog

Super Admin → Manage plans.

Admin can edit:

- monthly price
- trial duration
- feature availability
- staff/branch limits
- active/inactive status
- plan description

Changing a catalog price does not rewrite historical subscription price snapshots.

## Provider plans

Each active SaaS plan must be provisioned in Tablely's Razorpay account before customers can purchase it. The provider plan ID is stored on the corresponding `saas_plans` row.

## Restaurant controls

Existing admin tools continue to support restaurant status, trial invitations and subscription controls. All meaningful admin changes should be auditable.
