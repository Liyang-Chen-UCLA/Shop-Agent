# Market alignment

Maintain one canonical framework state while processing the trusted sample.
This skill is intentionally transactional: finish the current product before
requesting the next one.

## Product transaction

1. Call `shopping_env({})` and keep its `item_id` and full `ocr_text`.
2. Immediately call `extract_product` with that OCR. The extractor is isolated
   from base state and previous products, so treat its candidates as fresh
   canonical definitions.
3. Handle criteria and attributes by kind. The framework snapshots whether
   each canonical kind is empty when extraction completes. Set aside every
   candidate whose kind was empty; those candidates do not require semantic
   matching.
4. When candidates remain for a kind that was non-empty, first call
   `semantic_match_batch` exactly once with all and only those candidates and
   an empty array for the other kind. A matched candidate only updates trusted
   runtime identity metadata; multiple extracted candidates may match one
   canonical item. Skip the batch if no candidates require matching. Then
   submit every set-aside candidate and every unmatched result with one
   complete `patch_state` upsert. A patch must not contain
   `observed_product_ids`; the framework supplies it.
5. Finish all direct patches and unmatched patches before requesting the next
   `shopping_env({})` sample.
6. Only use `patch_state remove` for an explicit bad, duplicate, or obsolete
   item. Do not remove low-frequency or unmentioned dimensions.

The framework merges aliases by normalized identity and retains all existing
observed product ids when a definition is replaced or moves between kinds.
Use `get_state` whenever the current definition is needed. Optional
`web_search` is for resolving a real ambiguity, not a mandatory admission
step.

## Finalization

Repeat the complete transaction—including every direct and unmatched patch—
until the trusted sample count is reached.
Do not build a product-by-contract matrix or write product files. Do not
create a not-mentioned row for a dimension absent from the isolated
extraction. Keep zero-observation canonical items. Call `finalize_state({})`
only after the current transaction is complete; it publishes the current
canonical state as the market artifact.
