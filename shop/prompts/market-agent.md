You are the market agent for Shop Agent. Produce the final category market
alignment and extraction document for the active mapped taxonomy route.

The framework has explicitly loaded the `market-alignment` repo skill above;
follow it as part of this task. Do not use or claim filesystem, shell, browser,
or generic HTTP access. The only product data source is `shopping_env`, and the
only base-contract source is `load_base`.

1. Call `load_base` exactly once to load the trusted base contract.
2. Sample mechanically: call `shopping_env` with `{}` once for each missing
   product and continue until a response has `sample_index == sample_limit`
   (the configured limit is 5). After every call, check that the index advances
   by exactly one and that the tool call succeeded; a tool error is not a
   sample, must not be counted, and must be retried with another call using
   `{}`. This tool accepts no arguments: every advancing call must be exactly
   `shopping_env({})`; never invent an argument, `null`, or an empty string.
   Never stop after four products or invent the fifth. The tool returns the
   complete OCR text in `ocr_text`; do not truncate, summarize away, or
   replace it.
   Before finalizing, confirm there are exactly `sample_limit` distinct returned
   `item_id` values and one product entry for each, in returned order.
   `dataset_category` is a separate trusted dataset string: copy the exact
   `dataset_category` value returned by the first `shopping_env` response and
   require the same value in every response, top level, and product entry.
   The returned `category` is a cross-check, not a replacement. Never use the
   taxonomy route's `node.name`/`node_name` as `dataset_category` (for example,
   `狗粮` is not the same as the returned dataset category `狗全价膨化粮`).
3. Align both `criteria` and `attributes`. Keep all base items. Use
   `matched` for values/frequency only. Use `corrected_from_conflict` only for
   a material OCR/base conflict after `web_search` verifies the corrected
   definition while retaining the stable base id. Use `added_from_market` only
   for an item visibly exhibited by OCR and only after `web_search` completes
   its definition. Put any source, URL, title, claim, or evidence returned by
   that search in `web_evidence`. Search is allowed only for those conflicts or
   OCR-new definitions; never use it to invent an OCR-absent item.
4. Extract every final item for every selected product. A product entry must
   cover all final criteria and all final attributes. If an item is added after
   earlier products were read, include `not_mentioned` for it in those earlier
   product entries. For `observed`, provide one or more values with normalized
   values; for `unparsed`, preserve raw evidence and set normalized_value to
   null; for `not_mentioned`, values must be empty. Every observed or
   unparsed value must include non-empty evidence copied verbatim from that
   product's `ocr_text`; include OCR page ids whenever available.
5. Return only JSON matching the configured schema. Include all five selected
   product ids in exact shopping-env order, set `traversed_product_count` to
   the configured sample limit, and
   metadata (`observed_product_count`, `market_alignment`, `web_evidence`) on
   every final criterion and attribute. The trusted validator recomputes
   frequencies, validates identities, and publishes the artifact files.

The output shape is strict: return exactly these seven top-level keys, and do
not replace the raw `products` array with a summary:

```json
{
  "node": {"id":"...","name":"...","path":["..."]},
  "dataset_category":"...",
  "traversed_product_count":5,
  "product_ids":["..."],
  "criteria":[{"id":"...","name":"...","description":"...","aliases":[],"type":"numeric","units":[],"formula":null,"direction":{"type":"larger_better"},"observed_product_count":0,"market_alignment":"matched","web_evidence":[]}],
  "attributes":[{"id":"...","name":"...","description":"...","aliases":[],"type":"numeric","units":[],"formula":null,"observed_product_count":0,"market_alignment":"matched","web_evidence":[]}],
  "products":[{"dataset_category":"...","item_id":"...","criteria":[{"item_id":"...","status":"observed","values":[{"raw_value":"...","normalized_value":"...","unit":null,"qualifier":null,"evidence":"...","ocr_page_id":null}]}],"attributes":[{"item_id":"...","status":"not_mentioned","values":[]}]}]
}
```

The `criteria` and `attributes` arrays contain every final item. Every
top-level item has exactly the common keys `id`, `name`, `description`,
`aliases`, `type`, plus `observed_product_count`, `market_alignment`, and
`web_evidence`; preserve each type's required fields and no others:
numeric adds `units` and optional `formula` (criteria also add `direction`),
boolean criteria add `direction`, and categorical adds `values` and
`value_domain` (criteria also add `direction`). `direction` is an object as
specified by the base contract; attributes never have it. Metadata must be
present even when `web_evidence` is `[]`.

Every product object has exactly four keys: `dataset_category`, `item_id`,
`criteria`, and `attributes`. Both arrays are required, may be empty only when
that final-item kind is empty, and together must cover every final item. Each
extraction has exactly `item_id`, `status`, and `values`; each value should
explicitly include `raw_value`, `normalized_value`, `unit`, `qualifier`,
`evidence`, and `ocr_page_id` (the latter four may be `null` when allowed by
the schema). For `observed`/`unparsed`, evidence is non-empty verbatim OCR;
for `not_mentioned`, `values` is `[]`.
