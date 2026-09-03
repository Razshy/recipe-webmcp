# Recipe — pipelines that know where they'll break

A document-pipeline studio where an agent proposes conversion pipelines and an
**external scoring oracle** (a second origin) grades each one against a catalog of
real traps found during a 48-hour audit of an AI agent's document toolbox:
a converter that emits a package the image doesn't ship; conversions that exit 0
while writing nothing; a `-quality` flag honored for no value at all; an opener
command that silently launched a GUI that never closes. Pick an input, a goal, and
a step chain (or let the agent propose one) and watch the traps light up on the
exact steps that will bite — then run the REAL transforms in-browser.

## Run it

```bash
# multi-origin (recommended; serves main + scorer origins and the kit)
cd ../.. && python3 kit/harness.py --app apps/recipe   # tests
cd ../.. && python3 kit/serve.py --app apps/recipe     # serve, prints URLs

# or single-origin from this folder with any static server
python3 ../../kit/serve.py --app .
```

## How agents use it

Main origin (14 tools): `catalog_list`, `pipeline_build`, `pipeline_add_step`,
`pipeline_delete`, `pipeline_score` (delegates cross-origin to the scorer),
`pipeline_validate`, `pipeline_run` (executes real transforms: docx→text via a real
zip+OOXML parse, text→pdf→text round trip with sentinel, png→pdf→png, md→html,
xlsx→csv, csv→xlsx, zip pack/unpack…), `fixture_list`, `fixture_upload`,
`agent_propose`, `step_explain`, `run_history`, `oracle_call`, `recipe_bad_pipeline`.

Scorer origin (`exposedTo: main`): `score_pipeline`, `trap_list` (+ one unexposed
tool proving cross-origin visibility is explicit). The trap engine literally lives
on another site — the app can't grade its own homework.

```js
await window.mc.registerTool({
  name: 'pipeline_score',
  description: 'Score a built pipeline against the trap catalog (delegates to the scorer origin).',
  inputSchema: { type: 'object', properties: { pipelineId: { type: 'string' } }, required: ['pipelineId'] },
  execute: async ({ pipelineId }) => oracleScore(pipelineId) // cross-origin getTools({fromOrigins}) + executeTool
});
```

Simulated steps (badged in the UI): OCR (deterministic pseudo-words), summarize,
and one modelled converter that reproduces the exit-0-empty-output class.

MIT licensed.
