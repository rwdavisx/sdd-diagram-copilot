# Auth API

## Goal
Session-based authentication service.

## Endpoints
- `POST /auth/login` — email + password → session token (httpOnly cookie)
- `POST /auth/logout` — invalidate session
- `GET /auth/me` — current user

## Requirements
- Argon2 password hashing
- 429 after 5 failed attempts per 15 minutes per IP
- Sessions expire after 30 days of inactivity
