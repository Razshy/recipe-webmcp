# Recipe — pipelines that know where they'll break

**Live:** <https://razshy.github.io/recipe-webmcp/> — the hosted build is one GitHub Pages folder, i.e. single-folder mode.

A document-pipeline studio in which an agent proposes conversion pipelines, real transforms run in the tab on real bytes, and an **oracle the studio does not own** scores every chain against 15 documented traps — labelling each verdict *plan*, *measured* or *claimed*, because the studio is not allowed to grade its own homework. Served with `kit/serve.py` the oracle really is a second origin; the hosted build is a single GitHub Pages folder, so there it is a same-origin `<iframe>` (`window.MC.isMulti === false`) running the same code down the same `exposedTo` / `getTools({fromOrigins})` / `executeTool` path — the header pill on the live page says which mode you are looking at.

## Why WebMCP fits

WebMCP hands an agent `execute()` results that say "ok" about things the page may not have done. Every tool here is built around that failure: a converter that exits 0 while writing nothing, a `quality` flag that is accepted and ignored, a "convert" that only renames a file, an extractor that reads strings no pixel ever showed. Recipe makes the fix structural rather than rhetorical. The studio has **no trap engine at all** — the engine exists only under `scorer/`, registered there with `exposedTo`, discovered with `getTools({fromOrigins})` and executed with `executeTool`, with no local fallback if the oracle is unreachable. On the hosted single-folder build that scorer document is a same-origin frame, so the `exposedTo` list names the studio's own origin and gates nothing; run `python3 kit/serve.py --app apps/recipe` and the two are separate origins and the boundary is enforced for real. Either way the studio never computes a score. When the studio runs a pipeline it sends the oracle the step list, what it *observed* and the *artifact bytes*; the oracle re-sniffs those bytes itself and marks every trap hit with its basis — `plan` (the step list alone), `measured` (the oracle verified it from bytes) or `claimed` (only the studio's notes say so). No single tool is authoritative, and the page says so on every card.

## What people and agents can do together

Type these into ChatGPT's browser (or Chrome with the WebMCP flag) with the studio open:

1. **"Plan a docx → markdown pipeline, run it on the docx-memo fixture, and tell me whether the oracle measured or merely believed each trap it found."** → `pipeline_plan` → `pipeline_build` → `pipeline_run` (the run re-scores through the oracle; the card shows the evidence line and a `measured`/`claimed` chip per hit).
2. **"Score the pipeline ['rename-avif'] on a png before and after running it on png-scan, and explain why the score changed."** → `pipeline_build`, `pipeline_score` (70: T02, T03 from the plan), `pipeline_run` (40: T13 *measured* — the oracle re-sniffed PNG bytes declared AVIF).
3. **"Upload this text as a fixture, run it through text → pdf → text, and confirm the sentinel came back out."** → `fixture_upload` → `pipeline_build` → `pipeline_run` (the hand-rolled PDF writer and reader round-trip the bytes; the artifact preview carries the sentinel).

The person keeps the consequential action: `pipeline_delete` exists only while a human has ticked *let agents delete recipes*.

## Better UX

While the agent works, the human sees index cards appear on the canvas with a star meter (red when the oracle found traps), the offending step annotated inline with the trap's lesson, a `run: ok` / `run: FAILED` line per step with byte counts and magic bytes, and an evidence line saying what the oracle re-sniffed versus what the studio merely claimed. The run console streams every step; the agent-surface panel lists the tools exactly as an agent sees them (descriptions, parameters, read-only and origin chips), logs every invocation with input, output and timing, and lets the person run any tool by hand through `window.__agent`. Badges mark REAL vs SIMULATED transforms, native vs shim WebMCP, and multi-origin vs single-folder mode — on the live URL that last pill reads `origins: single folder (oracle is a same-origin iframe)`.

## How we implemented WebMCP

| tool | what | readOnly | registered on | in ChatGPT's browser | API |
|---|---|---|---|---|---|
| `catalog_list` | transforms with real/simulated mode and trap ids | yes | main | yes | imperative |
| `step_explain` | one transform's engine, params and the oracle's trap lessons | yes | main | yes | imperative |
| `fixture_list` | fixtures with sniffed magic bytes | yes | main | yes | imperative |
| `fixture_upload` | add a fixture from base64 or text; sniff vs declared type | no | main | yes | imperative |
| `pipeline_list` | every card with score, hits and selection | yes | main | yes | imperative |
| `pipeline_plan` | shortest catalogue chain for input → output | yes | main | yes | imperative |
| `pipeline_build` | create a card from a step list | no | main | yes | imperative |
| `pipeline_add_step` | append/insert a transform (the palette click) | no | main | yes | imperative |
| `pipeline_remove_step` | remove a step (the ✕ button) | no | main | yes | imperative |
| `pipeline_validate` | type-check the chain, name the missing connector | yes | main | yes | imperative |
| `pipeline_score` | ask the oracle; stores the verdict on the card | no | main | yes | imperative |
| `pipeline_run` | execute for real, then re-score with observed notes + artifact bytes | no | main | yes | imperative |
| `pipeline_propose` | scripted proposer + oracle verdict + gap | no | main | yes | imperative |
| `pipeline_seed_bad` | seed the known-bad recipe | no | main | yes | imperative |
| `pipeline_delete` | delete a card — registered only while a human arms it (AbortSignal) | no | main | yes, when armed | imperative |
| `run_history` | recent runs | yes | main | yes | imperative |
| `oracle_score_pipeline` | **bridge** to the scorer's `score_pipeline` | yes | main | yes | imperative |
| `oracle_trap_list` | **bridge** to the scorer's `trap_list` | yes | main | yes | imperative |
| `score_pipeline` | the trap engine: plan/measured/claimed verdict | yes | scorer document (`exposedTo` main) | no — registered inside the iframe; use the bridge | imperative |
| `trap_list` | the 15-trap catalogue with weights | yes | scorer document (`exposedTo` main) | no — registered inside the iframe; use the bridge | imperative |
| `warm_cache` | internal, registered without `exposedTo` | yes | scorer document | no — registered inside the iframe | imperative |

**How many tools, and who sees them.** GitHub Pages serves the whole app as one folder, so on the live URL `window.MC.isMulti === false` and the scorer document is a *same-origin* frame — the spec makes such frames transparent, so `getTools()` there returns **20** names on load (the 17 top-level ones plus the frame's `score_pipeline`, `trap_list` and even the unexposed `warm_cache`) and **21** while a human has armed `pipeline_delete`; the header pill counts `toolchange ×20` / `×21`. ChatGPT's browser never enters an iframe, same-origin or not, so there it discovers only the **17** tools registered on the top-level document (18 armed) and reaches the oracle through the two `oracle_*` bridges. Under `kit/serve.py` the scorer is a real second origin: `getTools({fromOrigins:[scorer]})` returns 19 — the 17 top-level plus the two the oracle exposes — and `warm_cache` is invisible because nothing exposed it.

`window.mc` is `document.modelContext` when the browser has WebMCP, else a spec-shaped shim (kit/mc.js). The registration code, from `src/tools.js`:

```js
function tool(def, options) {
  def.execute = guarded(def.name, def.execute);
  return window.mc.registerTool(def, options);
}

  await tool({
    name: 'pipeline_score',
    title: 'Score via the oracle',
    description: 'Send a pipeline to the scorer surface (the trap engine lives only under scorer/; this page has no scoring code) and store its verdict on the card. Sends the step list, the notes the last run observed and the last artifact\'s bytes; the oracle labels every hit basis "plan", "measured" (it re-sniffed the bytes) or "claimed" (only notes say so). Returns {score, penalty, stars, hits, evidence, oracle, via}; wrong_state when the oracle is unreachable.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Pipeline id, e.g. "p3". Defaults to the selected pipeline.' },
        claims: { type: 'object', description: 'Extra evidence you assert, e.g. {"emptyOutput": true}; the oracle marks hits from it as claimed.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: async (input) => {
      const r = resolvePipeline(input);
      if (r.error) return r.error;
      if (input.claims !== undefined && !isObject(input.claims)) return fail('invalid_param', 'claims must be an object of evidence flags', 'e.g. claims: {magicMismatch: true}');
      const res = await scoreAndStore(r.p, { run: r.p.lastRun, claims: input.claims });
      if (res.ok === false) return res;
      return Object.assign({ pipelineId: r.p.id, selfScore: r.p.selfScore, gap: r.p.selfScore == null ? null : r.p.selfScore - res.score }, verdictView(res));
    },
  });
```

`guarded()` wraps every `execute` so an expected failure is *returned* as `{ ok: false, error: { code, message, hint } }` (codes: `not_found | invalid_param | wrong_state | empty_result | rule_violation | needs_human`) and never thrown, and every invocation lands in the on-page log.

The oracle registers with `exposedTo` (`scorer/scorer.js`) — `MAIN_ORIGIN` is the studio's origin when the app is served on two origins, and the page's own origin in the hosted single-folder build:

```js
  await window.mc.registerTool({
    name: 'score_pipeline',
    …
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: guarded(scorePipeline),
  }, { exposedTo: [MAIN_ORIGIN] });
```

The studio reaches it only through discovery and execution (`src/oracle.js`):

```js
    tools = await window.mc.getTools({ fromOrigins: [SCORER_ORIGIN] });
    …
    res = parse(await window.mc.executeTool(tool, input || {}));
```

The human-armed tool uses an `AbortSignal` (`src/tools.js`):

```js
  controllers.del = new AbortController();
  await tool({
    name: 'pipeline_delete',
    …
  }, { signal: controllers.del.signal });
```

`disarmDelete()` calls `controllers.del.abort()`, the tool disappears, and `mc-toolchange` bumps the counter in the header. The scorer `<iframe>` carries `allow="tools"` so the framed document may register under the `tools` permissions policy — required when it is a sibling origin, harmless when it is same-origin.

## Try it

- **Multi-origin (the demo):** from the yard root, `python3 kit/serve.py --app apps/recipe` prints one URL per origin; open the `main` one. The scorer really is a different origin (another port).
- **Single folder (what the live URL runs):** `cd apps/recipe && python3 -m http.server 8080` and open `http://127.0.0.1:8080/`. The oracle becomes a same-origin iframe (`window.MC.isMulti === false`); the origin pill says so and `warm_cache` becomes visible, as the spec makes same-origin frames transparent. `python3 bundle.py recipe` (from the yard root) writes `dist/recipe/`, and that is exactly the shape hosted at <https://razshy.github.io/recipe-webmcp/>.
- **Browsers:** ChatGPT's desktop browser (Site tools enabled) discovers the 17 top-level tools, 18 with delete armed; Chrome 149+ with `chrome://flags/#enable-webmcp-testing` also lists the tools inside the iframe, so on the live single-folder site it sees 20 (21 armed) (DevTools → Application → WebMCP). Any other browser runs the kit shim; the header badge says which.
- **Prompts:** the three in *What people and agents can do together*. Without an agent, use the **Agent surface** panel: pick a tool, type JSON, press *Call it through window.__agent* — the same handle the tests use.

## Real vs simulated

- **Real, in this tab:** zip reader (stored + deflate via `DecompressionStream`) and writer; docx → text and xlsx → csv from those zips; csv → xlsx / docx packing; a hand-rolled PDF writer (Tj operators) and PDF text extractor / rasterizer with zlib FlateDecode inflation; markdown ↔ html (headings, lists, links, fences, pipe tables); PNG decode/encode/resize through canvas; the quality-parameter measurement (q1 and q99 really are byte-identical); the oracle's re-sniff of artifact bytes.
- **Simulated (badged SIMULATED in the palette, on cards and in tool results):** OCR (deterministic pseudo-words from a byte hash), the summariser (truncation), the soffice-like converter that exits 0 with an empty file, xlsx recalc, the legacy `.doc` extension-dispatch handler, the `rename-avif` format launderer, the scan table detector, and the scripted proposer (a pattern, not a model).

## Limitations

- ChatGPT's browser does not discover tools registered inside iframes, so `score_pipeline`, `trap_list` and `warm_cache` are invisible there — including on the hosted build, where they are same-origin and `getTools()` does list them for a flag-enabled Chrome. `oracle_score_pipeline` and `oracle_trap_list` bridge the two exposed ones from the top-level page and name the origin in their reply.
- Deployment mode is the one thing the live URL cannot show off: GitHub Pages serves one folder, so the `exposedTo` gate there points at the page's own origin and proves nothing by itself. The cross-origin behaviour it is written for — a real second origin, `warm_cache` invisible, `getTools({fromOrigins})` crossing a boundary — is what `python3 kit/serve.py --app apps/recipe` and the harness run, and `test_04_static.py` covers the hosted shape.
- No declarative (`<form toolname>`) tools are used; ChatGPT's browser would not run them anyway.
- Native WebMCP keeps only `readOnlyHint` and `untrustedContentHint`; side effects are stated in each description instead.
- The oracle can only *measure* what it is handed: byte length and magic bytes of the final artifact. Everything else it reports as `claimed`, which is the honest limit of a second opinion.
- Under native Chrome ≤152 `execute()` receives no `signal`; `pipeline_run` honours one when present.

## Tests

Four self-executing Playwright files on `kit/testkit.py`, run twice — against the kit shim and against native WebMCP (Chrome 149+, `--enable-features=WebMCPTesting`):

```bash
python3 kit/harness.py --app apps/recipe --mode both
python3 gate.py recipe
```

`test_01_surface.py` (inventory, schemas, annotations, cross-origin visibility, bridges, 26 error envelopes, duplicate names, the armed delete + toolchange), `test_02_pipelines.py` (Python-generated docx/xlsx/FlateDecode-PDF fixtures, sentinels, plan-vs-measured-vs-claimed verdicts before and after runs, DOM meters and chips), `test_03_human.py` (clicks only), `test_04_static.py` (`python3 -m http.server` single-folder mode). Executed checks: **144 in shim mode and 144 in native mode** (41 + 55 + 34 + 14), zero console or page errors in either.

## License

MIT — see `LICENSE`.
