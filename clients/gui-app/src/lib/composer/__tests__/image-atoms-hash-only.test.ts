import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  hashOnlyImageHashes,
  inlineHashOnlyImageBytes,
} from "@/lib/composer/image-atoms";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function docWith(...nodes: JsonContent[]): JsonContent {
  return { type: "doc", content: [{ type: "paragraph", content: nodes }] };
}

function hashOnlyImageNode(hash: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id: `img-${hash.slice(0, 6)}`,
      fileName: "screenshot.png",
      mimeType: "image/png",
      size: 128,
      hash,
    },
  };
}

function inlineImageNode(hash: string, b64content: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id: `img-inline-${hash.slice(0, 6)}`,
      fileName: "screenshot.png",
      mimeType: "image/png",
      size: 128,
      hash,
      b64content,
    },
  };
}

describe("hashOnlyImageHashes", () => {
  it("finds a nested hash-only node", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [docWith(hashOnlyImageNode(HASH_A))],
            },
          ],
        },
      ],
    };

    expect(hashOnlyImageHashes(content)).toEqual([HASH_A]);
  });

  it("ignores a node that already carries b64content", () => {
    const content = docWith(inlineImageNode(HASH_A, "abc123"));

    expect(hashOnlyImageHashes(content)).toEqual([]);
  });

  it("collects both a hash-only and an inline node's hash-only sibling", () => {
    const content = docWith(
      inlineImageNode(HASH_A, "abc123"),
      hashOnlyImageNode(HASH_B),
    );

    expect(hashOnlyImageHashes(content)).toEqual([HASH_B]);
  });
});

describe("inlineHashOnlyImageBytes", () => {
  it("rewrites the node in place, dropping hash and keeping the rest", () => {
    const content = docWith(hashOnlyImageNode(HASH_A));
    const bytesByHash = new Map([[HASH_A, "base64-payload"]]);

    const rewritten = inlineHashOnlyImageBytes(content, bytesByHash);

    const node = rewritten.content?.[0]?.content?.[0];
    expect(node?.attrs).toEqual({
      id: `img-${HASH_A.slice(0, 6)}`,
      fileName: "screenshot.png",
      mimeType: "image/png",
      size: 128,
      b64content: "base64-payload",
    });
    expect(node?.attrs?.hash).toBeUndefined();
  });

  it("leaves an unchanged subtree referentially equal", () => {
    const untouched = docWith(hashOnlyImageNode(HASH_B));
    const content: JsonContent = {
      type: "doc",
      content: [untouched, docWith(hashOnlyImageNode(HASH_A))],
    };
    const bytesByHash = new Map([[HASH_A, "base64-payload"]]);

    const rewritten = inlineHashOnlyImageBytes(content, bytesByHash);

    expect(rewritten.content?.[0]).toBe(untouched);
    expect(rewritten).not.toBe(content);
  });

  it("returns the same content reference when the map is empty", () => {
    const content = docWith(hashOnlyImageNode(HASH_A));

    expect(inlineHashOnlyImageBytes(content, new Map())).toBe(content);
  });

  it("leaves a node untouched when its hash is absent from the map", () => {
    const content = docWith(hashOnlyImageNode(HASH_A));
    const bytesByHash = new Map([[HASH_B, "base64-payload"]]);

    const rewritten = inlineHashOnlyImageBytes(content, bytesByHash);

    expect(rewritten).toBe(content);
    const node = rewritten.content?.[0]?.content?.[0];
    expect(node?.attrs?.hash).toBe(HASH_A);
    expect(node?.attrs?.b64content).toBeUndefined();
  });
});
