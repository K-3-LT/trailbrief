# TrailBrief local Mastra application

Original project code remains **UNLICENSED**; dependency licenses remain applicable. This application is separate from the recorded public Pages demo under the repository root `docs/`.

```sh
npm ci --ignore-scripts
npm start
```

Node.js >=22.13 is required. Open `http://127.0.0.1:4317` and load the fictional sample. The labeled deterministic demo invokes the actual Mastra workflow without calling a model. HTML and JSON exports include the supplied snapshots. The server is loopback-only and must not be exposed as a public inference backend.

The actual workflow validates snapshots, selects evidence, and verifies/builds the pocket brief. In model mode, the adapter sends a finite program-generated segment table and accepts only sourceId/segmentId selections. The backend rejects unknown, duplicate, cross-source and recognizable instruction IDs, copies original text and adds fixed checks. Model-written evidence, questions and extra fields cannot become source evidence. The original contiguous-quotation verifier also checks assembled quotes.

The optional HTTP model flow remains locked by `billingPolicy=null`. Its local temporary-session source is included, but no live approval, key, environment configuration or funded execution ledger ships with this release. The public `/docs` page has no key form or model/backend connection at all.

See the repository root README for recorded real results, exact limits, verification commands and the distinction between private delivery artifacts and a public demo. Source dates and authenticity are not independently verified. These are synthetic tests, not field-tested travel advice. The documented dependency advisory and unverified local browser key flow remain limits of this Node prototype.
