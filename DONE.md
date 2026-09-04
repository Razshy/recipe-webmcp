# DONE — recipe

**Status: complete on kit v2.** `python3 kit/harness.py --app apps/recipe --mode both` → ALL PASS
(shim 144 checks, native 144 checks across 4 files); `python3 gate.py recipe` → PASS; zero console or
page errors in both modes; single-folder static mode tested with a plain `python3 -m http.server`.

## What is real
- Zip reader (stored + deflate via `DecompressionStream`, with a fallback inflater) and STORE writer;
  docx → text and xlsx → csv parsed out of those zips; csv → xlsx and text → docx packing.
- Hand-rolled PDF writer (Helvetica, `Tj` ops, xref) and PDF content-stream extractor / rasterizer;
  FlateDecode streams are inflated as zlib (raw-deflate fallback), and an undecodable stream is reported
  as `decodeFailed`, never silently skipped. Verified in tests against a Python `zlib`-compressed PDF.
- Markdown ↔ html (headings, emphasis, code, links, lists, pipe tables as one closed `<table>`), html → text.
- PNG decode/encode/resize through canvas; the PNG `quality` measurement (byte-identical at q1 and q99).
- Magic-byte sniffing before every REAL step that consumes bytes: a step handed the wrong bytes fails loudly
  and the observation (`magicMismatch`) survives the failure.
- The oracle's own measurement: it decodes the artifact bytes the studio sends and derives `emptyOutput`
  / `magicMismatch` itself; hits from that are labelled `measured`, hits from caller notes `claimed`,
  hits from the step list alone `plan`. The studio has no scoring engine (the trap engine exists only
  under `scorer/`), so there is no local fallback: an unreachable oracle is `{ok:false, wrong_state}`.
- Cross-origin plumbing: `exposedTo` on the scorer, `getTools({fromOrigins})` + `executeTool` in the
  studio, `allow="tools"` on the iframe, an unexposed decoy (`warm_cache`), an `AbortSignal`-gated
  `pipeline_delete` that only exists while a person has armed it, `mc-toolchange` counted in the header.
  Served with `kit/serve.py` (and in the harness) the scorer is a genuinely separate origin and that
  gating is enforced; hosted on GitHub Pages the whole app is one folder, so `window.MC.isMulti === false`,
  the scorer document is a same-origin frame, `exposedTo` names the studio's own origin and gates nothing,
  and `warm_cache` is visible. Same code path in both; the origin pill states which one is live.

## What is simulated (badged SIMULATED in the palette, on every card, and in tool results)
- `ocr` — deterministic pseudo-words hashed from the image bytes, confidence always low.
- `summarize` — deterministic sentence truncation.
- `docx-pdf-soffice` — models the exit-0-empty-output class (with `params.empty` it writes 0 bytes).
- `xlsx-recalc` — reports success with a non-empty error list.
- `office-text` — legacy handler that dispatches on the file extension, not the bytes.
- `rename-avif` — declares AVIF, writes the PNG bytes unchanged.
- `png-tables` — scan table detector that returns an empty grid and no exception.
- The proposer (`pipeline_propose`) is a scripted pattern, not a model; the UI says so.

## Tool surface (what the agent sees)
Counts on the hosted single-folder build: **20 names register on load, 21 while delete is armed**
(`getTools()` sees the same-origin scorer frame too). ChatGPT's browser does not enter iframes, so there
it is the **17** top-level tools, 18 armed. Served on two origins, `getTools({fromOrigins:[scorer]})`
returns 19: the 17 top-level plus the two the oracle exposes.

- Studio origin (top-level, visible to ChatGPT's browser): `catalog_list`, `step_explain`, `fixture_list`,
  `fixture_upload`, `pipeline_list`, `pipeline_plan`, `pipeline_build`, `pipeline_add_step`,
  `pipeline_remove_step`, `pipeline_validate`, `pipeline_score`, `pipeline_run`, `pipeline_propose`,
  `pipeline_seed_bad`, `run_history`, the bridges `oracle_score_pipeline` / `oracle_trap_list`, and
  `pipeline_delete` while armed.
- Scorer document (registered inside the iframe, so invisible to ChatGPT's browser in either mode;
  visible to Chrome with the flag): `score_pipeline` and `trap_list` (`exposedTo` main), plus
  `warm_cache` (unexposed — hidden when the scorer is a real second origin, visible on the hosted
  single-folder build because the frame is then same-origin and the spec makes such frames
  transparent; the origin pill and the on-page copy say so).
- Every tool validates its input in code and returns `{ok:false, error:{code, message, hint}}` for
  expected failures; a wrong `pipelineId` or fixture name is an error, never a success on another target.
  Only `readOnlyHint` / `untrustedContentHint` are used.

## Review triage (phase-1 report, 27 findings)
- Fixed (critical/high/medium): R1 `textDecode` import (text uploads run), R2 zlib FlateDecode, R3 XSS
  (all rendering is `textContent`/`createElement`, no `innerHTML`), R4 unknown fixture → `not_found`,
  R5 unknown pipelineId → `not_found`, R6 pdf-text sniffs and fails loudly with the note kept, R7 score
  description built from `SEVERITY_WEIGHT`, R8 README snippet copied from source, R9 pipe tables, R10 scorer
  validation, R11 `oracle_call` replaced by two bridges, R12 fixture_upload type mapping / replace / base64
  error, R13 tests rewritten (score before vs after run, every tool executed, static mode), R14 no
  self-grading (no `runScore`, no local fallback, oracle labels claimed vs measured), R15 copy qualified and
  tested, R16 mislabeled-scan input selects its fixture, R17 trap engine exists only on the scorer origin.
- Fixed (low): R18 evidence line on the card, R19 `let r`, R20 notes survive a failed step, R21 dead
  code removed and one `el()` helper, R22 renders coalesced on rAF and the tool list refreshed only on
  toolchange, R23 run-failure style / iframe height / oracle stars / pill counts only score calls,
  R24 copy fixed (15 traps; no xdg-open/fontenc claims), R25 `pipeline_plan`, `pipeline_list`,
  `pipeline_remove_step` and every button routed through `window.__agent.call`, R26 oracle fields rendered
  as text, R27 one input shape per tool, coerced/validated params and enums.
- Refuted: none. Deferred: none.

## Known limits
- The oracle can only measure byte length and magic bytes of the final artifact; everything else stays
  `claimed`. Under native Chrome ≤152 `execute()` gets no `signal`; the run loop honours one when present.
- ChatGPT's browser sees only the top-level tools; the two bridges cover the exposed oracle tools there.
- The live URL runs single-folder mode, so it demonstrates the API path but not the origin boundary:
  there the oracle is a same-origin frame. `python3 kit/serve.py --app apps/recipe` and the harness run
  it on two real origins, where `exposedTo` and `fromOrigins` actually gate; `test_04_static.py` covers
  the hosted single-folder shape.

## Commands (verified)
```
cd /Users/kendallbooker/Downloads/webmcp && python3 kit/harness.py --app apps/recipe --mode both
cd /Users/kendallbooker/Downloads/webmcp && python3 gate.py recipe
cd /Users/kendallbooker/Downloads/webmcp && python3 kit/serve.py --app apps/recipe
cd /Users/kendallbooker/Downloads/webmcp/apps/recipe && python3 -m http.server 8080
```
