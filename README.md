# TrailBrief

TrailBrief turns supplied route and weather snapshots into a portable evidence brief. A model selects source segment IDs; the Node backend validates their ownership and copies original source slices. Questions and checklist text are fixed program text. The actual three-step workflow uses `@mastra/core/workflows`.

**Public demo: recorded synthetic results, live API disabled.** GitHub Pages should serve **`main` → `/docs`**, which contains `.nojekyll`. That directory contains only static HTML/CSS/JavaScript, saved synthetic records, screenshots and downloads. It has no model endpoint, key form, account or backend. Choosing a case displays a saved record and never runs inference. A private Library download is a delivery artifact, not a public demo URL.

## License

Original TrailBrief code is **UNLICENSED**. Public visibility does not make the original project code open source or grant an additional license. Mastra and other third-party dependencies retain their own licenses. The package manifests, license inventory and 147 available installed-package license/notice files are preserved under `third-party-licenses/`; this includes Mastra's complete supplied license text and Zod's MIT license. No third-party code or license was relicensed.

## The recorded results

| Attempt | Case | Result |
| --- | --- | --- |
| 1 | Footbridge closure, quotation contract | Aggregate extraction rejection; original assistant body unavailable. |
| 2 | Expired forecast, quotation contract | `finish_reason=length`, empty answer; all 2048 completion tokens also reported as reasoning. |
| 3 | Untrusted source, quotation contract | Valid JSON/schema; a weather quote was rewritten and failed exact matching. |
| 4 | New closure + forecast gap, ID contract v1 | Accepted: four existing IDs, four original source quotes; override instruction not selected. |
| 5 | Supplied forecast window + no reported closure, frozen ID v1 | Accepted: six IDs/quotes, including both predefined required evidence lines. |
| 6 | Missing access/weather data, frozen ID v1 | `API_TRANSPORT_ERROR` after 30.014 seconds; no body or usage. State uncertain, no retry or accepted brief. |

These are development records, not a benchmark, ranking or success-rate claim. All inputs are synthetic; no outdoor field test or live weather verification occurred. The missing-data case passed offline assembly tests, but its real request did not produce a result.

The continuous validation record retains six requests and **$1.50 reservation**. Reservation is not spending. Conventional estimates based on reported usage for attempts 1–5 total **$0.013918**; attempt 6 may have unreported charges. No final invoice was received. No further request is authorized by this release.

## Run the actual local Mastra application

Requires Node.js >=22.13. Install the locked dependencies and use the clearly labeled deterministic demo:

```sh
npm --prefix app/trailbrief ci --ignore-scripts
npm --prefix app/trailbrief start
```

Open `http://127.0.0.1:4317`. The local server binds to loopback; its HTTP billing policy remains null and model/key controls stay locked. The generic model adapter and actual ID assembly/workflow are included for inspection and testing. Live runtime ledgers, coordinator approval files and environment configurations are excluded. The supplemental execution CLI is source-only in this public release; it does not ship a fresh funded ledger or authorize another run.

## Verify without a key or external calls

Remove the exact `TRAILBRIEF_API_KEY` variable from the test child process before running these commands. The supplied guard blocks external fetch/socket connections; tests use synthetic credentials and mocked model responses.

```sh
node --import ./verification/no-external-network.mjs --test app/trailbrief/test/*.test.js controller/controller.test.mjs diagnostics/extraction-diagnostics.test.mjs diagnostics/segment-regression.test.mjs
npm --prefix app/trailbrief run check
node --check docs/app.js
node --check docs/data.js
```

82 offline tests passed before the last two calls. Optional browser QA uses Python Playwright and an existing `/usr/bin/chromium` installation; these are verification tools, not runtime dependencies:

```sh
python3 verification/static-demo-browser-test.py
```

Desktop/mobile browser checks passed: records 4/5 displayed, failed records displayed without fallback, download bytes matched the saved brief, no password inputs/forms, and only local static GET requests occurred. See `evidence/static-demo-browser-qa.json`.

## Scope and remaining limits

Exact source copying verifies provenance within pasted text, not truth, freshness, complete forecast coverage or suitability. A model can omit evidence. Recognizable override directives are blocked, but this is not a claim of complete prompt-injection detection. Source text is never executed. Human review and checks with actual official sources remain necessary. Only exported briefs work offline; real model selection needs an external provider.

The documented moderate transitive dependency advisory remains a limitation of the local Node prototype. The Pages demo ships no npm runtime bundle or inference backend. The local HTTP model mode and production backend remain locked; this release makes no production-readiness claim. See `app/trailbrief/docs/DEPENDENCY_RISK.md`.

## Layout

`docs/` is the sole Pages source. `app/trailbrief/` contains the actual local application and tests. `controller/` contains the bounded executor source, synthetic cases and tests. `diagnostics/` retains the historical quote contract and ID regression. `evidence/` contains selected public-safe recorded results. `publication/` contains the DEV Week 1 draft and publisher handoff. `third-party-licenses/` contains dependency metadata and supplied license/notice texts.

Built for DEV's [Week 1 challenge](https://dev.to/challenges/hacktoberfest-week1-2026-10-05). Any post-deadline commits must be identified here before a submission claim. Publication URLs and repository dates must be verified by the separate publisher; no website or repository was published from this preparation environment.
