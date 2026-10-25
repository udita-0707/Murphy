# @murphy/dev-receiver

A local webhook receiver for trying Murphy end to end. It verifies every request's
Standard Webhooks signature with your endpoint secret, logs it as valid or invalid, flags
repeated `webhook-id`s as duplicates, and can simulate failures.

```sh
export RECEIVER_SECRET=whsec_...   # preferred over --secret, which shows up in process lists and pnpm's output
pnpm receiver --port 4242
pnpm receiver --fail 3 --status 503 --retry-after 5
pnpm receiver --delay-ms 8000
```

Register `http://127.0.0.1:4242/webhooks` as an endpoint (the worker needs `MURPHY_MODE=local`
to deliver to localhost). Use `127.0.0.1` rather than `localhost`: the receiver listens on
IPv4 only, and `localhost` may resolve to `::1` first. Invalid signatures get a 401.

Change behaviour while it runs:

```sh
curl -X POST localhost:4242/_control -d '{"fail":2,"status":500,"delayMs":0,"retryAfter":null}'
curl localhost:4242/_control   # current behaviour and counts
```
