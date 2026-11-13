# Ops addendum 2026-02

The cutover window for the billing migration must avoid month-end: invoices batch job runs on the last 2 business days of each month.
Monitoring requirement: alert if v1 endpoints receive more than 100 rps after cutover.
