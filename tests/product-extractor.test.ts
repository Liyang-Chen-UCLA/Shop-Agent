import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import test from "node:test";
import { createModelRuntime } from "../src/framework/model-runtime.ts";
import { discoverNativeTools } from "../src/framework/native-tools.ts";
import {
  createProductExtractorTool,
  SUBMIT_PRODUCT_EXTRACTION_TOOL,
  validateProductExtraction,
  validateProductExtractionInput,
} from "../src/framework/product-extractor.ts";
import { validateJsonSchema } from "../src/framework/schema.ts";
import { extractProductInputSchema, productExtractionOutputSchema } from "../shop/schemas.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let responseSequence = 0;

function validExtraction(suffix: string) {
  return {
    criteria: [{
      id: `battery_life_${suffix}`,
      name: "续航时间",
      description: "产品可持续使用的时间",
      aliases: [],
      type: "numeric",
      units: ["小时"],
      direction: { type: "larger_better" },
    }, {
      id: `waterproof_${suffix}`,
      name: "防水",
      description: "产品是否具备防水能力",
      aliases: [],
      type: "boolean",
      direction: { type: "true_better" },
    }, {
      id: `color_${suffix}`,
      name: "颜色",
      description: "产品可选颜色",
      aliases: [],
      type: "categorical",
      values: ["黑色"],
      value_domain: "open",
      direction: { type: "preferred_set", values: ["黑色"] },
    }],
    attributes: [{
      id: `weight_${suffix}`,
      name: "重量",
      description: "产品重量",
      aliases: [],
      type: "numeric",
      units: ["千克"],
    }, {
      id: `foldable_${suffix}`,
      name: "折叠方式",
      description: "产品是否支持折叠",
      aliases: [],
      type: "boolean",
    }, {
      id: `finish_${suffix}`,
      name: "表面处理",
      description: "产品表面处理方式",
      aliases: [],
      type: "categorical",
      values: ["磨砂"],
      value_domain: "closed",
    }],
  };
}

function contextText(context: { messages: unknown[] }): string {
  const message = context.messages[0] as { content?: unknown } | undefined;
  const content = typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((part) => (
        part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
          ? String(part.text)
          : ""
      )).join("")
      : "";
  if (!content) throw new Error("test model did not receive one text message");
  const match = content.match(/^<ocr_text>\n([\s\S]*)\n<\/ocr_text>$/);
  if (!match) throw new Error("test model received an unexpected OCR envelope");
  return match[1];
}

function toolCallStream(model: any, toolName: string, output: unknown) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: `extract-submit-${++responseSequence}`, name: toolName, arguments: output }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as never;
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message } as never);
    stream.push({ type: "done", reason: "toolUse", message } as never);
  });
  return stream;
}

test("product extraction accepts complete canonical criteria and attributes", () => {
  assert.ok(discoverNativeTools().has("extract_product"));
  const ocrText = "商品A 续航 8 小时 可折叠";
  const input = { item_id: "sku-a", dataset_category: "设备", ocr_text: ocrText };
  assert.deepEqual(validateJsonSchema(extractProductInputSchema, input), { valid: true });
  assert.deepEqual(validateProductExtractionInput(input), input);

  const output = validExtraction("a");
  assert.deepEqual(validateJsonSchema(productExtractionOutputSchema, output), { valid: true });
  assert.deepEqual(validateProductExtraction(output), output);

  const duplicateId = structuredClone(output) as any;
  duplicateId.attributes[0].id = duplicateId.criteria[0].id;
  assert.throws(() => validateProductExtraction(duplicateId), /duplicate candidate id/);

  const invalidCanonicalItem = structuredClone(output) as any;
  delete invalidCanonicalItem.criteria[0].units;
  assert.throws(() => validateProductExtraction(invalidCanonicalItem), /output schema/);

  const emptyId = structuredClone(output) as any;
  emptyId.attributes[0].id = "";
  assert.throws(() => validateProductExtraction(emptyId), /id must be a non-empty string/);

  assert.throws(
    () => validateProductExtractionInput({ ...input, base: {} }),
    /input schema/,
  );
});

test("extract_product creates independent contexts for different products and writes no product files", async () => {
  const contexts: Array<{ messages: unknown[]; tools: string[] }> = [];
  const runtime = createModelRuntime();
  const model = runtime.getModel("hy3");
  runtime.models.streamSimple = (_model, context) => {
    contexts.push({
      messages: structuredClone(context.messages),
      tools: (context.tools ?? []).map((tool) => tool.name),
    });
    const ocrText = contextText(context);
    const suffix = ocrText.includes("第一") ? "a" : "b";
    return toolCallStream(model, context.tools?.[0]?.name ?? SUBMIT_PRODUCT_EXTRACTION_TOOL, validExtraction(suffix));
  };

  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-extract-product-"));
  try {
    const tool = createProductExtractorTool({ runtime, projectRoot });
    const [first, second] = await Promise.all([
      tool.execute("extract-a", { item_id: "sku-a", dataset_category: "设备", ocr_text: "第一商品 续航 8 小时 可折叠" }),
      tool.execute("extract-b", { item_id: "sku-b", dataset_category: "设备", ocr_text: "第二商品 续航 12 小时 不可折叠" }),
    ]);

    assert.equal(contexts.length, 2);
    const firstText = "第一商品 续航 8 小时 可折叠";
    const secondText = "第二商品 续航 12 小时 不可折叠";
    for (const context of contexts) {
      assert.equal(context.messages.length, 1);
      const serialized = JSON.stringify(context.messages);
      const hasFirst = serialized.includes(firstText);
      const hasSecond = serialized.includes(secondText);
      assert.notEqual(hasFirst, hasSecond);
      assert.deepEqual(context.tools, [SUBMIT_PRODUCT_EXTRACTION_TOOL]);
      assert.doesNotMatch(serialized, /sku-a|sku-b|设备/);
    }

    const firstOutput = JSON.parse((first.content[0] as { text: string }).text);
    const secondOutput = JSON.parse((second.content[0] as { text: string }).text);
    assert.equal(firstOutput.criteria[0].id, "battery_life_a");
    assert.equal(secondOutput.criteria[0].id, "battery_life_b");
    assert.equal("item" in firstOutput.criteria[0], false);
    assert.equal((first.details as any).item_id, "sku-a");
    assert.equal((second.details as any).dataset_category, "设备");
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
