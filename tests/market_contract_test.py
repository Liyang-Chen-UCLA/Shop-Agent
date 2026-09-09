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


def market_document(weight=None, material=None, extra=None):
    base = base_document()
    value = {
        "node": NODE,
        "criteria": [{**base["criteria"][0], "observed_product_ids": weight if weight is not None else []}],
        "attributes": [{**base["attributes"][0], "observed_product_ids": material if material is not None else []}],
    }
    if extra:
        value.update(extra)
    return value


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
        }
        self.original_route = market.active_market_route
        self.original_shopping_route = shopping.active_market_route
        market.active_market_route = lambda _context: (ROUTE, "乒乓底板")
        shopping.active_market_route = lambda _context: (ROUTE, "乒乓底板")

    def tearDown(self):
        market.active_market_route = self.original_route
        shopping.active_market_route = self.original_shopping_route
        self.directory.cleanup()

    def sample(self, count=5):
        return [shopping.next_product(self.context)["item_id"] for _ in range(count)]

    def test_mapping_and_rank_item_order_reread_and_exhaustion(self):
        self.assertEqual(market.dataset_category_for_node("5598"), "儿童冲锋衣")
        self.assertEqual(market.dataset_category_for_node("5322"), "儿童冲锋衣")
        self.assertEqual(market.dataset_category_for_node("2394"), "手机直播补光灯")
        selected = self.sample()
        self.assertEqual(selected, ["2", "3", "4", "5", "1"])
        self.assertEqual(shopping.reread_product(self.context, "2")["ocr_text"], "OCR-2")
        with self.assertRaisesRegex(ValueError, "sample_exhausted"):
            shopping.next_product(self.context)
        with self.assertRaisesRegex(ValueError, "not selected"):
            shopping.reread_product(self.context, "6")
        with self.assertRaisesRegex(ValueError, "only an empty object"):
            shopping.shopping_env({"item_id": "2"}, self.context)

    def test_five_product_canonical_state_publishes_without_matrix_or_product_files(self):
        market.persist_base(base_document(), self.context)
        selected = self.sample()
        value = base_document()
        value["criteria"] = [
            {
                **value["criteria"][0],
                "name": "重量范围",
                "aliases": ["重量"],
                "observed_product_ids": ["2", "3", "4"],
            },
            {
                "id": "surface_type",
                "name": "表面类型",
                "description": "底板表面的类型",
                "aliases": [],
                "type": "categorical",
                "values": ["黏性", "涩性"],
                "value_domain": "open",
                "direction": {"type": "preferred_set", "values": ["黏性"]},
                "observed_product_ids": ["4"],
            },
        ]
        value["attributes"][0]["observed_product_ids"] = []
        result = market.publish_market(value, self.context)
        self.assertEqual(set(result), {"node", "criteria", "attributes"})
        self.assertEqual(result["criteria"][0]["observed_product_ids"], ["2", "3", "4"])
        self.assertEqual(result["criteria"][1]["observed_product_ids"], ["4"])
        self.assertEqual(result["attributes"][0]["observed_product_ids"], [])
        self.assertEqual(selected, ["2", "3", "4", "5", "1"])
        self.assertNotIn("dataset_category", result)
        self.assertNotIn("products", result)
        artifact = Path(self.directory.name) / "market-criteria" / "3375"
        self.assertTrue((artifact / "market.json").is_file())
        self.assertFalse((artifact / "products").exists())
        self.assertEqual(json.loads((artifact / "market.json").read_text(encoding="utf-8")), result)

    def test_runtime_ids_must_be_unique_and_sampled_and_invalid_publish_is_atomic(self):
        market.persist_base(base_document(), self.context)
        self.sample()
        artifact = Path(self.directory.name) / "market-criteria" / "3375" / "market.json"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text('{"sentinel": true}\n', encoding="utf-8")

        duplicate = market_document(weight=["2", "2"])
        with self.assertRaisesRegex(ValueError, "must be unique"):
            market.publish_market(duplicate, self.context)
        self.assertEqual(json.loads(artifact.read_text(encoding="utf-8")), {"sentinel": True})

        unknown = market_document(weight=["unknown"])
        with self.assertRaisesRegex(ValueError, "not a valid product id|not sampled"):
            market.publish_market(unknown, self.context)
        self.assertEqual(json.loads(artifact.read_text(encoding="utf-8")), {"sentinel": True})

        old_shape = market_document(extra={"products": []})
        with self.assertRaisesRegex(ValueError, "exactly node, criteria, and attributes"):
            market.publish_market(old_shape, self.context)
        self.assertEqual(json.loads(artifact.read_text(encoding="utf-8")), {"sentinel": True})

    def test_definition_validation_is_separate_from_runtime_metadata(self):
        market.persist_base(base_document(), self.context)
        self.sample()
        invalid = market_document()
        invalid["criteria"][0]["direction"] = {"type": "target_range", "unit": "小时"}
        with self.assertRaisesRegex(ValueError, "market criteria/attribute definition rejected|target_range"):
            market.publish_market(invalid, self.context)

    def test_publish_requires_exact_configured_sample_count(self):
        market.persist_base(base_document(), self.context)
        self.sample(3)
        with self.assertRaisesRegex(ValueError, "exactly 5 trusted samples"):
            market.publish_market(market_document(), self.context)

    def test_publish_honors_configured_non_five_limit(self):
        self.context["maxDistinctProducts"] = 3
        market.persist_base(base_document(), self.context)
        selected = self.sample(3)
        result = market.publish_market(market_document(weight=[selected[0]]), self.context)
        self.assertEqual(result["criteria"][0]["observed_product_ids"], [selected[0]])
        self.assertEqual(set(result), {"node", "criteria", "attributes"})


if __name__ == "__main__":
    unittest.main()
