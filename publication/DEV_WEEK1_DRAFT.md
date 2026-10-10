---
title: "TrailBrief: Keep the Evidence, Leave the Screen"
published: false
tags: devchallenge, hf26challenge
---

My entry for DEV's [Week 1: Touch Grass](https://dev.to/challenges/hacktoberfest-week1-2026-10-05).

## What I Built

TrailBrief turns a pasted route notice and weather snapshot into a pocket brief you can save as a self-contained HTML file, review offline or print.

It is for someone preparing a short outing who wants the important source evidence in one place. The aim is to make the screen a small part of preparation: collect the notices, check the gaps, take the brief, and verify conditions with the actual land manager and weather service before leaving.

The AI has a narrow job. It selects source segment IDs. The backend copies the original text and adds fixed check questions. It never asks the model to invent a forecast, decide that a route is safe, or compose the evidence quotations.

All examples in this post and demo are synthetic. I have not field-tested this application or authenticated real trail or weather data.

## Demo

PUBLIC_DEMO_URL_PENDING — the publication coordinator must insert the verified GitHub Pages URL here before submission. This is deliberately not a private artifact link.

The public page is labeled **Recorded model result / live API disabled**. You can switch between six real request records, inspect the synthetic source inputs and selected IDs, compare the failures, and download the two accepted briefs. Changing the selector does not call a model. There is no API-key field or live backend.

The fourth record includes a closed boardwalk, missing forecast coverage and an embedded source instruction telling the model to declare the route safe. The model selected four permitted IDs. The backend copied the closure, the forecast gap and the two official-source check reminders exactly. The instruction segment was not selected.

The fifth record supplies a forecast window that contains the planned departure and a notice reporting no closures. Its six selected segments all copied exactly, including both required evidence lines. These statements are true within the supplied fictional text; the application does not independently verify the conditions.

## Code

[Source repository](https://github.com/K-3-LT/trailbrief). The publication coordinator has created this new repository and will upload the prepared release before submission.

The repository contains the actual local Node/Mastra application, locked dependencies, tests, recorded results and the static `/docs` demo. Original TrailBrief source remains **UNLICENSED**. Public source visibility is not an additional open-source license; dependency licenses and notices are preserved separately.

## How I Built It

The application uses `@mastra/core` 1.75.0 and Zod with a locked npm dependency graph. The real workflow has three steps:

1. Validate the two supplied snapshots and add review warnings.
2. Select evidence through the model adapter, or use the explicitly labeled deterministic demo.
3. Verify the selection and assemble the portable brief.

The first contract asked the model to return verbatim quotations. The early calls showed why this was fragile:

| Attempt | What happened |
| --- | --- |
| 1 | Extraction was rejected. The original assistant body was not retained, so I cannot reconstruct the exact cause. |
| 2 | The 2048-token completion allowance was exhausted with an empty answer and `finish_reason=length`. The provider also reported all 2048 tokens as reasoning. |
| 3 | With an 8192-token allowance, JSON and schema validation passed. But a quotation changed “an imaginary valley” to “a valley”, so exact matching rejected it. |
| 4 | I changed the contract to ID selection. Four valid IDs produced an accepted, deterministically assembled brief. |
| 5 | The frozen ID version accepted a different normal fixture: supplied forecast coverage and no reported closure. |
| 6 | The frozen version's missing-data fixture encountered `API_TRANSPORT_ERROR` after about 30 seconds. No body or usage was received. It remained uncertain and was not retried. |

For the new contract, the program splits each supplied source into bounded original slices. IDs bind the source ID, complete source text and positions. The model returns only `sourceId` and `segmentId`. Strict validation rejects additional fields, unknown IDs, repeats, cross-source substitutions and recognizable override directives. The program then copies the selected original slices and runs the existing exact-quotation check. No fuzzy matching or quotation repair happens.

Questions and checklist items are fixed program text. A model-written explanation cannot silently become evidence. Full snapshots and selected IDs stay available for review.

All six calls used the external `deepseek/deepseek-v4.1-flash` model with low reasoning and zero retries. The fourth API request through complete response-body receipt took 12.216 seconds; the fifth took 15.602 seconds. These measurements include the network and provider response, not just model compute. The sixth did not yield a completed-response measurement.

There were 82 passing offline tests before the last two calls. They cover ID stability, ownership, unknown/repeated IDs, strict fields, instruction isolation, missing-weather handling, exact copying, safe export, actual Mastra execution with mocked extraction, budget continuity and first-error stop. Separate desktop/mobile browser checks verified that the static demo displayed recorded results, exposed no key form, made only local static GET requests and downloaded byte-identical saved briefs.

This is a small development record, not a benchmark or success-rate claim. The missing-data case has offline coverage but no accepted real response. Reported usage for attempts 1–5 yields a conventional estimate of $0.013918 at the provider's [published token prices](https://iteracompute.com/pricing/). That excludes any unknown charge for attempt 6 and is not a final invoice. The retained $1.50 reservation is a safety allowance, not actual spending.

## Why Does Open Innovation Matter?

Mastra makes the workflow boundaries inspectable: I can keep model selection separate from source validation and export, and test the same orchestration with an injected mock adapter. It is central to the local application's working path, rather than an unused dependency added for a badge.

The main design change was possible because the evidence contract is owned by the application. I could replace fragile model-written quotations with ID selection while leaving the workflow and the source-verification boundary intact. An OpenAI-compatible adapter also separates provider transport from evidence assembly; I tested one fixed model, not a broad provider comparison.

The open-source claim here is about the framework and third-party components. My original source is currently UNLICENSED. The model is called through an external provider. Exported briefs can be read offline, but real model selection does not run offline and is not a free hosted service.

Important limits remain: pasted text and timestamps are not authenticated; exact copying does not establish truth, freshness, completeness or safety; models can omit important evidence; recognizable instruction detection is not a complete injection defense; and a documented moderate transitive dependency advisory remains in the local Node prototype. The public site serves plain static records, not that Node runtime or a live inference service. Human review is required.

## My Agent Session

I used AI assistance for implementation and review. I am publishing the source, synthetic fixtures, validation records and failure history rather than a raw session log that could contain private configuration. The recorded demo shows the model inputs, retained assistant outputs and deterministic assembly trace without request headers or credentials.

## Prize Categories

Best Use of Mastra — the actual three-step local workflow uses Mastra's workflow API in both the deterministic demo and model-selection paths. No other partner category is claimed.
