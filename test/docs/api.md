# Billing API v2 migration notes

The billing team confirmed that Billing API v2 goes live on 2026-03-01.
The endpoint `POST /v2/invoices` replaces `POST /v1/invoices` and requires an idempotency key header.
Response shape changed: `data.amount_minor` is now an integer in cents, not a float.
Legacy v1 endpoints will be sunset 6 months after v2 GA.
