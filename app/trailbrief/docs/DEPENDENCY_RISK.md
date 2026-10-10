# Dependency risk review

Review date: 2026-10-10. Scope: this pinned local prototype, its current user-input path and current installed dependency graph. This is not a comprehensive security audit.

## Finding

`@mastra/core@1.75.0 → gray-matter@4.0.3 → js-yaml@3.15.2 → argparse@1.0.10 → sprintf-js@1.0.3`.

The [reviewed advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) concerns attacker-controlled format strings whose numeric precision can trigger an uncaught RangeError. It lists no patched release. npm reports five moderate affected-package entries because it propagates the single underlying advisory through this chain; these are not five distinct demonstrated flaws in TrailBrief.

## Current reachability evidence

- TrailBrief passes user text to Zod, JSON serialization, direct string slicing/includes, model messages, and HTML escaping. It does not call sprintf, a YAML CLI, workspace skills or agent-skills parsing on that text.
- The installed `gray-matter/lib/engines.js` uses js-yaml's library functions. `js-yaml/index.js` loads `./lib/js-yaml.js`; a search of these library files found no argparse or sprintf import.
- The installed `js-yaml/bin/js-yaml.js` imports argparse for its CLI. TrailBrief does not spawn this CLI, accept command-line format strings, or shell out with source input.
- The installed `argparse/lib/argument_parser.js` imports sprintf-js. Therefore there is a vulnerable installed package, even though this application's current path does not appear to reach it.
- `docs/trace-dependencies.mjs` used Node's synchronous module-resolution hooks while running a real Mastra demo workflow and a model-path workflow with injected extraction. It observed gray-matter and js-yaml loading, but zero argparse or sprintf-js loads. `dependency-trace.json` preserves the relative module evidence. This confirms only the tested paths, not all possible Mastra code paths.
- A regression test carries a format-like string through the workflow as literal source data without invoking a formatter.

Assessment: **No demonstrated reachable path from current HTTP/source inputs to the affected formatter.** The package remains vulnerable in the install. This finding is not a “safe” certificate and can change with enabled features, CLI use, framework upgrades, or different error paths.

## Limits and release decision

- Keep this prototype loopback-only. Host allowlisting, same-origin checks, JSON requirements and a 40 KB request cap reduce unrelated exposure; they do not patch sprintf-js.
- Do not blindly apply npm's proposed major Mastra downgrade. Do not suppress the advisory or use a fake fixed version.
- Public backend deployment remains blocked pending an explicit risk decision, rate/concurrency limits, request/provider-response limits, authentication or other abuse controls, real-provider review, and runtime security review. Never expose this credential-bearing prototype directly.
- A source-only release or recorded/static demonstration does not need to expose the vulnerable runtime to public inputs, but must retain the warning and pin the lockfile.
- Before any hosted release, rerun npm audit and tests, review a genuine upstream fix if available, and repeat reachability analysis for the exact shipped versions and enabled features.
