# CSRF Protection Stance — Sprint 5A

## Decision

**SameSite=Lax cookies only. No CSRF tokens for Sprint 5A.**

## Rationale

1. All session cookies (`ojt_admin_session`, `ojt_customer_session`) are set with `SameSite=Lax`
2. All state-changing API operations use POST/PUT/DELETE (no GET mutations)
3. SameSite=Lax prevents cookies from being sent on cross-site POST requests
4. All API calls use `fetch()` which does not send cookies cross-origin by default
5. The application does not embed in iframes from other origins
6. No cross-origin form submissions are supported

## When to revisit

- If the app needs to be embedded in cross-origin iframes
- If cross-domain form submissions are needed
- If SameSite cookie support drops below acceptable browser coverage (currently ~97%)

## Verification checklist

- [ ] No GET endpoint performs state mutations
- [ ] All session cookies have `SameSite=Lax`
- [ ] All session cookies have `HttpOnly` and `Secure` (in production)

## Alternative (for future sprints)

If CSRF tokens are needed later, use the `csrf` npm package or implement a
double-submit cookie pattern. Add a `X-CSRF-Token` header to all state-changing
requests and validate server-side.
