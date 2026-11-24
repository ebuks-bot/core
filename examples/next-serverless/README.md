# next-serverless

Next.js example: server-side transaction signing with a secret key, batch operations, and a Vercel/Lambda-style serverless handler.

```
API route (server) — load account → build tx → sign with secret key → submit
Client page (browser) — trigger action → poll result → show status
```

## Patterns covered

- Server-side signing with `signTransactionOffline` (no browser wallet needed)
- Batch account fetches with `client.account.getAccountsBatch`
- Building a payment on the server and submitting from an API route
- Vercel/Lambda handler pattern: one-shot client, sign, submit, return result
- Separating server-only code (secret keys) from browser code

## Files

| File | Purpose |
|---|---|
| `src/sorokitServer.ts` | Server-side helpers: client factory, sign-and-submit, batch fetch |
| `src/otelSetup.ts` | OpenTelemetry exporter wiring (optional, tree-shaken when unused) |
| `src/pages/api/payment.ts` | Next.js API route: receives POST, builds, signs, and submits |
| `src/pages/api/balances.ts` | API route: batch balance fetch for multiple public keys |
| `src/pages/index.tsx` | Client page: triggers the payment and displays the result |
| `src/lambda.ts` | Drop-in AWS Lambda / Vercel Edge handler (same logic, different runtime) |

## Setup

```bash
npm install sorokit-core @creit.tech/stellar-wallets-kit next react react-dom
```

Set your secret key as an environment variable — never hard-code it:

```bash
# .env.local
SIGNING_SECRET_KEY=S...
STELLAR_NETWORK=testnet
```

## OpenTelemetry exporter (optional)

`@opentelemetry/api` is a peer dependency — install it only when you want to
forward metrics and traces to Prometheus, Jaeger, Datadog, or any OTLP-
compatible backend. The SDK and this example work without it.

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node
```

Call `setupTelemetryFromGlobalProviders()` once at server startup (before any
request is processed):

```ts
// server.js or _app.tsx (server-side only)
import { setupTelemetryFromGlobalProviders } from "./src/otelSetup";

await setupTelemetryFromGlobalProviders();
```

After that every `traceSpan`, `traceTransactionSubmit`, and `traceContractCall`
call in the SDK automatically forwards spans and metrics through your registered
OTel providers.

If you hold explicit `Tracer` and `Meter` instances rather than relying on
global registration, use the `createOtelApiExporterFromProviders` helper shown
in `src/otelSetup.ts`.

## Security note

`signTransactionOffline` accepts a raw secret key. Keep it in an environment
variable and never expose it to the browser. The API routes in this example are
server-only (`pages/api/`) and Next.js never bundles them into the client.

## Running type-checks

```bash
npm run typecheck:examples
```
