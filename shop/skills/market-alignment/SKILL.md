---
name: market-alignment
description: Align a category evaluation contract with the configured Taobao OCR sample and extract auditable criterion and attribute evidence.
---

# Market alignment

Use the trusted base contract as the starting namespace. Keep every base item,
even when no selected OCR context mentions it. Mark each base item
`matched` unless the OCR exposes a material conflict that is corrected with a
stable id and completed web evidence (`corrected_from_conflict`). Add a new
item only when OCR visibly exhibits it and a completed `web_search` defines
it (`added_from_market`); never invent an OCR-absent item.

Sample with `shopping_env({})` until its returned `sample_index` equals the
trusted `sample_limit` (five in the configured profile); verify that each
successful call advances the index by one and that tool errors are not counted.
This tool accepts no arguments: every advancing call must be exactly
`shopping_env({})`; never invent an argument, `null`, or an empty string, and
retry a failed call with `{}`. Do not finalize with only four products. Copy the exact
`dataset_category` returned by `shopping_env`—including the same value into
the top-level document and every product entry. It is distinct from the
taxonomy route `node.name`/`node_name`; never substitute a route name for it.

For every selected product (the configured sample limit defaults to five) and
every final criterion/attribute, emit exactly one extraction with status
`observed`, `unparsed`, or `not_mentioned`.
Observed entries may contain multiple values, and every observed or unparsed
value must carry non-empty evidence copied verbatim from that product's OCR
text. Unparsed entries retain raw OCR evidence and use null normalized values;
not-mentioned entries have no values.
If a new item is discovered late, append `not_mentioned` entries for it to
earlier products. Frequencies count products with observed or unparsed status,
not the number of values.

The final JSON has exactly seven top-level keys: `node`, `dataset_category`,
`traversed_product_count`, `product_ids`, `criteria`, `attributes`, and the
raw `products` array. Never replace `products` with a summary. Each product
object has exactly four required keys—`dataset_category`, `item_id`,
`criteria`, and `attributes`—and both extraction arrays must be present, even
when empty. Together they must cover every final criterion and attribute.
Each extraction has exactly `item_id`, `status`, and `values`; each value may
contain only `raw_value`, `normalized_value`, `unit`, `qualifier`, `evidence`,
and `ocr_page_id`. Keep the nullable fields explicit when useful, and always
copy non-empty verbatim OCR into `evidence` for observed/unparsed values.

Every top-level criterion or attribute must retain its common/type-specific
definition fields and the metadata `observed_product_count`,
`market_alignment`, and `web_evidence`. Numeric items require `units` (and
may have `formula`); categorical items require `values` and `value_domain`;
criteria additionally require their contract `direction` object. Attributes
must omit `direction` entirely. Do not add fields outside the configured
schema.
