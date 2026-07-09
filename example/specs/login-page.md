# Login Page

## Goal
Let users sign in with email + password, with a "forgot password" escape hatch.

## Requirements
- Email + password form with inline validation
- Calls `POST /auth/login` on the Auth API
- On success, store session token and redirect to `/`
- Rate-limit feedback: show "too many attempts" after HTTP 429

## Out of scope
- Social login (future item)
