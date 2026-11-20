// codec 层 1 单测：verifyVectors 过全量 vectors.json（encode + feed，含 #30 新增向量）。
// vitest 测 dist（@ble-light/logic）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyVectors } from "@ble-light/logic";

const vectors = JSON.parse(readFileSync(new URL("../protocol/vectors.json", import.meta.url), "utf8"));

describe("codec 协议向量（layer 3 TS 端）", () => {
  it("verifyVectors 复算 encode + feed 全部向量并返回 true", () => {
    expect(verifyVectors(vectors)).toBe(true);
  });

  it("vectors.json 结构完整（encode/feed 非空）", () => {
    expect(vectors.meta).toBeDefined();
    expect(vectors.encode.length).toBeGreaterThan(0);
    expect(vectors.feed.length).toBeGreaterThan(0);
  });
});