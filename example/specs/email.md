# Transactional Email

## Goal
Send order confirmations and password resets via Postmark.

## Requirements
- Templates: order-confirmation, password-reset
- Retries with exponential backoff on 5xx
- All sends logged with message id for support lookup
