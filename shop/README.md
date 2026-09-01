# Shop workspace

This directory is the only place for Shop Agent business extensions:

- `agents.ts` registers orchestrator and subagent profiles plus explicit tool allowlists.
- `prompts/` contains the role instructions referenced by those profiles.
- `criteria_contract.py` contains the authoritative Pydantic contract for transient criteria results.
- `market_contract.py` validates market alignment/extraction output, recomputes
  frequencies, and publishes the generated artifacts atomically.
- `skills/market-alignment/SKILL.md` is explicitly loaded into `market_agent`.
- `tools/` contains manifest-based Python tools.
- `data/` contains the canonical product taxonomy used by the route agent.
- `requirements.txt` pins the Python packages required by the business tools.

The orchestrator maintains one minimal category-analysis task per taxonomy node. The route agent progressively resolves product names through the taxonomy, `criteria_agent` researches the resolved route to produce a base evaluation contract, and `market_agent` aligns that contract with the configured number of deterministic Taobao OCR contexts (default five). Task preferences are not passed to either specialist.

Market artifacts are written under `.shop-agent/market-criteria/<node_id>/`:
`base.json` is the criteria-stage contract, `products/<item_id>.json` contains
one complete extraction per selected product, and `market.json` is published
last as the validated index. Existing `market.json` is reused; an existing
`base.json` skips the criteria stage. The configured dataset path and
`maxDistinctProducts` (default `5`) live in `shop-agent.config.ts`. Sampling is sorted by
`rank` ascending then `item_id` ascending (the parquet order is otherwise
ambiguous); all taxonomy nodes mapped to one Taobao category therefore receive
the same configured sequence. The model-visible `shopping_env` tool accepts
only `{}` and advances the trusted per-run cursor to the next product.

Framework runtime code belongs in `src/framework/`; TUI presentation belongs in `src/tui/`.
