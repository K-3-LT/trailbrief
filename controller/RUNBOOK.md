# Public executor source: inactive

The bounded executor source and mocked tests are included for inspection. Live `authorization.json`, `state/`, approvals, key data and ledger locks are excluded. No fresh round, reset or additional real request is authorized by this source release. The actual charged-round ledger remains outside the public package and retains six attempts/$1.50 reserve, including the uncertain sixth transport result.

All real attempts used the fixed external deepseek/deepseek-v4.1-flash model, low reasoning, single concurrency and zero retries. Attempts 1–2 used 2048 output tokens; attempts 3–6 used 8192. Attempts 4–6 used the same frozen ID-selection contract/prompt v1. Unknown IDs, invalid ownership, duplicates, recognizable instruction segments, missing required evidence or response/usage errors fail closed.

Model-written quotation text is not repaired or fuzzy-matched. The program assembles source evidence deterministically from IDs. Public fixtures and selected safe numeric results are under `cases.json` and the root `evidence/`. The sixth fixture remains a failed/uncertain request, not a fabricated unknown-weather response.

Run tests with the exact real key absent and the external-network guard enabled. Public Pages must serve only the root `/docs` directory. The local HTTP application's billing policy remains null; publishing source does not enable an inference service.
