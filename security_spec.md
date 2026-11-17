# Firestore Security Specification

## 1. Data Invariants
1. **Admin-Only Catalog & Settings Control**: Only authenticated, email-verified store admins (`koolm6948@gmail.com` or UID present in `/admins/{uid}`) may create, update, or delete `/products/{productId}` or write `/settings/public`.
2. **No Silent Re-Seed After Full Deletion**: `/settings/public.catalogInitialized` remains `true` even when all `/products` documents are deleted, ensuring deleted items stay deleted across refreshes and devices.
3. **PII Isolation on Orders**: `/orders/{orderId}` contains buyer contact info (`buyerName`, `contactMethod`, `contact`). Public shoppers may only `create` valid `Pending` orders against an existing, in-stock product; `get`, `list`, `update`, and `delete` on `/orders` are strictly restricted to `isAdmin()`.
4. **Strict Field Allowlists & Bounds**: Every create/update enforces `keys().hasAll(...)` + `keys().hasOnly(...)`, path ID regex `^[a-zA-Z0-9_\-]+$` (<= 128 chars), string length bounds, quantity integer `1..4`, and server timestamps (`request.time`).
5. **Immutable Order Ownership & Timestamps**: On order status updates by admin, `id`, `productId`, and `createdAt` remain immutable and only `status` + `updatedAt` may change.

## 2. The "Dirty Dozen" Attack Payloads (All Must Deny)
1. **Unauthenticated Product Creation**: Anonymous visitor creates `/products/hacked-item`.
2. **Email Spoofing Attack**: Signed-in user with `email == 'koolm6948@gmail.com'` but `email_verified == false` tries to delete `/products/infinity-cube`.
3. **Shadow Field Injection on Product**: Admin writes extra ghost key `isFeatured: true` to `/products/infinity-cube`.
4. **ID Poisoning Attack**: Admin creates `/products/../../etc/passwd` or 200-char ID.
5. **Unbounded Array / Price Overflow on Product**: Admin writes `colors: []` or `colors` > 12 items or `price: -5`.
6. **Public Order PII Scraping (List)**: Non-admin signed-in user or anonymous visitor runs `list` on `/orders`.
7. **Public Order PII Read (Get)**: Non-admin user tries `get` on `/orders/ORD-1001`.
8. **Pre-Completed Order Spoofing**: Visitor creates `/orders/ORD-9999` with `status: 'Completed'` instead of `'Pending'`.
9. **Orphaned / Out-of-Stock Order**: Visitor creates `/orders/ORD-9998` referencing a nonexistent or out-of-stock `productId`.
10. **Quantity Limit Bypass**: Visitor creates `/orders/ORD-9997` with `quantity: 10` (> 4 max) or `quantity: 0`.
11. **Timestamp Tampering**: Visitor creates `/orders/ORD-9996` with backdated `createdAt` != `request.time`.
12. **Self-Assigned Admin Escalation**: Non-admin user tries to create `/admins/{theirUid}` with `role: 'admin'`.
