import json
import tempfile
import unittest
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as parquet

import shop.market_contract as market
import shop.tools.shopping_env_common as shopping


ROUTE = {
    "node_id": "3375",
    "node_name": "乒乓底板",
    "node_path": "体育用品 > 室内游戏 > 乒乓球用品 > 乒乓球拍",
}
NODE = {
    "id": "3375",
    "name": "乒乓底板",
    "path": ["体育用品", "室内游戏", "乒乓球用品", "乒乓球拍"],
}


def base_document():
    return {
        "node": NODE,
        "criteria": [{
            "id": "weight",
            "name": "重量",
            "description": "底板重量",
            "aliases": [],
            "type": "numeric",
            "units": ["克"],
            "direction": {"type": "smaller_better"},
        }],
        "attributes": [{
            "id": "material",
            "name": "材质",
            "description": "底板材质",
            "aliases": [],
            "type": "categorical",
            "values": ["木材"],
            "value_domain": "open",
        }],
    }


def value(raw, normalized, evidence):
    return {
        "raw_value": raw,
        "normalized_value": normalized,
        "unit": "克",
        "qualifier": None,
        "evidence": evidence,
        "ocr_page_id": "page-1",
    }


class MarketContractTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.dataset = Path(self.directory.name) / "products.parquet"
        ids = ["1", "2", "3", "4", "5", "6"]
        parquet.write_table(
            pa.table({
                "item_id": ids,
                "category": ["乒乓底板"] * len(ids),
                "rank": [5, 1, 2, 3, 4, 6],
                "context_text": [f"OCR-{item}" for item in ids],
            }),
            self.dataset,
        )
        self.context = {
            "dataDirectory": self.directory.name,
            "datasetPath": str(self.dataset),
            "sessionId": "session",
            "runId": "run",
            "maxDistinctProducts": 5,
            "searchStats": {"succeeded": 0},
        }
        self.original_route = market.active_market_route
        self.original_shopping_route = shopping.active_market_route
        market.active_market_route = lambda _context: (ROUTE, "乒乓底板")
        shopping.active_market_route = lambda _context: (ROUTE, "乒乓底板")

    def tearDown(self):
        market.active_market_route = self.original_route
        shopping.active_market_route = self.original_shopping_route
        self.directory.cleanup()

    def test_mapping_and_rank_item_order_reread_and_exhaustion(self):
        self.assertEqual(market.dataset_category_for_node("5598"), "儿童冲锋衣")
        self.assertEqual(market.dataset_category_for_node("5322"), "儿童冲锋衣")
        self.assertEqual(market.dataset_category_for_node("2394"), "手机直播补光灯")
        selected = [shopping.next_product(self.context)["item_id"] for _ in range(5)]
        self.assertEqual(selected, ["2", "3", "4", "5", "1"])
        self.assertEqual(shopping.reread_product(self.context, "2")["ocr_text"], "OCR-2")
        with self.assertRaisesRegex(ValueError, "sample_exhausted"):
            shopping.next_product(self.context)
        with self.assertRaisesRegex(ValueError, "not selected"):
            shopping.reread_product(self.context, "6")
        with self.assertRaisesRegex(ValueError, "only an empty object"):
            shopping.shopping_env({"item_id": "2"}, self.context)

    def _candidate(self, ids):
        base = base_document()
        products = []
        for index, item_id in enumerate(ids):
            products.append({
                "dataset_category": "乒乓底板",
                "item_id": item_id,
                "criteria": [{
                    "item_id": "weight",
                    "status": "observed" if index < 3 else "not_mentioned",
                    "values": [value(str(index), index, f"OCR-{item_id}")] if index < 3 else [],
                }],
                "attributes": [{
                    "item_id": "material",
                    "status": "not_mentioned",
                    "values": [],
                }],
            })
        return {
            "node": NODE,
            "dataset_category": "乒乓底板",
            "traversed_product_count": self.context["maxDistinctProducts"],
            "product_ids": ids,
            "criteria": [dict(base["criteria"][0], observed_product_count=999, market_alignment="matched", web_evidence=[])],
            "attributes": [dict(base["attributes"][0], observed_product_count=999, market_alignment="matched", web_evidence=[])],
            "products": products,
        }

    def test_frequency_is_recomputed_and_files_publish_in_order(self):
        base = base_document()
        market.persist_base(base, self.context)
        ids = ["2", "3", "4", "5", "1"]
        self.assertEqual([shopping.next_product(self.context)["item_id"] for _ in range(5)], ids)
        result = market.publish_market(self._candidate(ids), self.context)
        self.assertEqual(result["criteria"][0]["observed_product_count"], 3)
        self.assertEqual(result["attributes"][0]["observed_product_count"], 0)
        artifact = Path(self.directory.name) / "market-criteria" / "3375"
        self.assertTrue((artifact / "market.json").is_file())
        self.assertEqual(sorted(path.stem for path in (artifact / "products").glob("*.json")), sorted(ids))
        self.assertEqual(json.loads((artifact / "products" / "2.json").read_text(encoding="utf-8"))["item_id"], "2")

    def test_coverage_and_status_invariants_reject_invalid_output(self):
        market.persist_base(base_document(), self.context)
        ids = ["1", "2", "3", "4", "5"]
        selected = [shopping.next_product(self.context)["item_id"] for _ in range(5)]
        ids = selected
        candidate = self._candidate(ids)
        candidate["products"][0]["criteria"][0]["status"] = "unparsed"
        candidate["products"][0]["criteria"][0]["values"][0]["normalized_value"] = 4
        with self.assertRaisesRegex(ValueError, "normalized_value must be null"):
            market.publish_market(candidate, self.context)

    def test_hallucinated_ocr_evidence_is_rejected(self):
        market.persist_base(base_document(), self.context)
        ids = [shopping.next_product(self.context)["item_id"] for _ in range(5)]
        candidate = self._candidate(ids)
        candidate["products"][0]["criteria"][0]["values"][0]["evidence"] = "hallucinated OCR"
        with self.assertRaisesRegex(ValueError, "verbatim substring"):
            market.publish_market(candidate, self.context)

    def test_publish_honors_configured_non_five_limit(self):
        self.context["maxDistinctProducts"] = 3
        market.persist_base(base_document(), self.context)
        ids = [shopping.next_product(self.context)["item_id"] for _ in range(3)]
        result = market.publish_market(self._candidate(ids), self.context)
        self.assertEqual(result["traversed_product_count"], 3)
        self.assertEqual(result["product_ids"], ids)
        artifact = Path(self.directory.name) / "market-criteria" / "3375"
        self.assertEqual(sorted(path.stem for path in (artifact / "products").glob("*.json")), sorted(ids))


if __name__ == "__main__":
    unittest.main()
