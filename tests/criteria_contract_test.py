import unittest

from pydantic import ValidationError

from shop.criteria_contract import CriteriaDocument


def document(criteria=None, attributes=None):
    return {
        "node": {"id": "267", "name": "手机", "path": ["电子产品", "通讯"]},
        "criteria": criteria or [],
        "attributes": attributes or [],
    }


class CriteriaContractTest(unittest.TestCase):
    def test_representative_items(self):
        value = document(
            criteria=[
                {
                    "id": "battery_life",
                    "name": "续航",
                    "description": "持续使用时间",
                    "aliases": [],
                    "type": "numeric",
                    "units": ["小时"],
                    "direction": {"type": "larger_better"},
                },
                {
                    "id": "waterproof",
                    "name": "防水",
                    "description": "具备防水能力",
                    "aliases": [],
                    "type": "boolean",
                    "direction": {"type": "true_better"},
                },
                {
                    "id": "screen_type",
                    "name": "屏幕类型",
                    "description": "显示技术",
                    "aliases": [],
                    "type": "categorical",
                    "values": ["LCD", "OLED"],
                    "value_domain": "closed",
                    "direction": {"type": "total_order", "order": ["OLED", "LCD"]},
                },
            ],
            attributes=[
                {
                    "id": "weight",
                    "name": "重量",
                    "description": "产品重量",
                    "aliases": [],
                    "type": "numeric",
                    "units": ["克"],
                },
                {
                    "id": "color",
                    "name": "颜色",
                    "description": "外观颜色",
                    "aliases": [],
                    "type": "categorical",
                    "values": ["黑", "白"],
                    "value_domain": "open",
                },
            ],
        )
        result = CriteriaDocument.model_validate(value)
        self.assertEqual(result.node.id, "267")

    def test_partial_order_cycle_is_rejected(self):
        item = {
            "id": "quality",
            "name": "质量",
            "description": "综合质量",
            "aliases": [],
            "type": "categorical",
            "values": ["a", "b", "c"],
            "value_domain": "open",
            "direction": {"type": "partial_order", "better_than": [["a", "b"], ["b", "c"], ["c", "a"]]},
        }
        with self.assertRaises(ValidationError):
            CriteriaDocument.model_validate(document(criteria=[item]))

    def test_collisions_and_invalid_direction_references_are_rejected(self):
        collision = {
            "id": "battery_life",
            "name": "电池",
            "description": "d",
            "aliases": ["Battery Life"],
            "type": "boolean",
            "direction": {"type": "true_better"},
        }
        # Equivalent id/alias labels inside one item are allowed. A duplicate
        # alias itself remains invalid.
        CriteriaDocument.model_validate(document(criteria=[collision]))

        cross_item = {**collision, "id": "other_metric", "name": "其他", "aliases": ["Battery Life"]}
        with self.assertRaises(ValidationError):
            CriteriaDocument.model_validate(document(criteria=[collision, cross_item]))
        with self.assertRaises(ValidationError):
            CriteriaDocument.model_validate(document(criteria=[{**collision, "aliases": ["x", "X"]}]))

        invalid_preferred = {
            "id": "material",
            "name": "材质",
            "description": "d",
            "aliases": [],
            "type": "categorical",
            "values": ["a", "b"],
            "value_domain": "open",
            "direction": {"type": "preferred_set", "values": ["c"]},
        }
        with self.assertRaises(ValidationError):
            CriteriaDocument.model_validate(document(criteria=[invalid_preferred]))

    def test_invalid_shape_and_semantic_matrix(self):
        numeric = {
            "id": "metric",
            "name": "指标",
            "description": "d",
            "aliases": [],
            "type": "numeric",
            "units": ["小时"],
            "direction": {"type": "larger_better"},
        }
        categorical = {
            "id": "mode",
            "name": "模式",
            "description": "d",
            "aliases": [],
            "type": "categorical",
            "values": ["a", "b", "c"],
            "value_domain": "closed",
            "direction": {"type": "partial_order", "better_than": [["a", "b"]]},
        }
        cases = {
            "wrong_type_fields": {**numeric, "type": "boolean"},
            "extra_field": {**numeric, "unexpected": True},
            "target_unit_missing": {**numeric, "direction": {"type": "target_range", "unit": "天"}},
            "units_duplicate": {**numeric, "units": ["小时", "小时"]},
            "categorical_empty": {**categorical, "values": []},
            "categorical_duplicate": {**categorical, "values": ["a", "A"]},
            "total_order_open": {**categorical, "value_domain": "open", "direction": {"type": "total_order", "order": ["a", "b", "c"]}},
            "total_order_incomplete": {**categorical, "direction": {"type": "total_order", "order": ["a", "b"]}},
            "total_order_too_short": {**categorical, "values": ["a"], "direction": {"type": "total_order", "order": ["a"]}},
            "partial_endpoint": {**categorical, "direction": {"type": "partial_order", "better_than": [["a", "z"]]}},
            "partial_self": {**categorical, "direction": {"type": "partial_order", "better_than": [["a", "a"]]}},
            "partial_duplicate": {**categorical, "direction": {"type": "partial_order", "better_than": [["a", "b"], ["a", "b"]]}},
            "partial_empty": {**categorical, "direction": {"type": "partial_order", "better_than": []}},
            "preferred_empty": {**categorical, "direction": {"type": "preferred_set", "values": []}},
            "preferred_invalid": {**categorical, "direction": {"type": "preferred_set", "values": ["z"]}},
            "preferred_closed_entire": {**categorical, "direction": {"type": "preferred_set", "values": ["a", "b", "c"]}},
        }
        for name, item in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(ValidationError):
                    CriteriaDocument.model_validate(document(criteria=[item]))

        attribute_cases = {
            "attribute_direction": {"id": "flag", "name": "标志", "description": "d", "aliases": [], "type": "boolean", "direction": {"type": "true_better"}},
            "nonnumeric_units": {"id": "flag", "name": "标志", "description": "d", "aliases": [], "type": "boolean", "units": []},
            "nonnumeric_formula": {"id": "flag", "name": "标志", "description": "d", "aliases": [], "type": "boolean", "formula": "x"},
            "attribute_categorical_empty": {"id": "mode", "name": "模式", "description": "d", "aliases": [], "type": "categorical", "values": [], "value_domain": "open"},
            "attribute_categorical_duplicate": {"id": "mode", "name": "模式", "description": "d", "aliases": [], "type": "categorical", "values": ["a", "A"], "value_domain": "open"},
        }
        for name, item in attribute_cases.items():
            with self.subTest(name=name):
                with self.assertRaises(ValidationError):
                    CriteriaDocument.model_validate(document(attributes=[item]))


if __name__ == "__main__":
    unittest.main()
