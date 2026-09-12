import { describe, expect, it } from "vitest";
import { CLI_CONFIG_VERSION, cliConfigSchema } from "../schema";

/**
 * D11 added a `hostSettings` block to `~/.traycer/cli/config.json` for
 * settings that belong to the MACHINE RUNNING THE HOST (currently just
 * `browserVideoPlane`), read/written over `config.hostSettings.get`/`.set`.
 *
 * The block is deliberately additive - `.default()`-ed at both the object
 * and the field level - specifically so it needs NO `CLI_CONFIG_VERSION`
 * bump (see the block's own docstring in `../schema.ts`). That is a claim
 * about backward AND forward compatibility that is worth pinning directly:
 * an older config file that predates the block must still parse (backward),
 * and a newer file's block must never let an attacker- or corruption-added
 * key widen what round-trips through it (forward/hostile-input safety, the
 * same property `adversarial-hostile-config.test.ts` checks for the rest of
 * the schema). Losing either property silently would only surface as a
 * parse failure or a data leak on someone's machine, long after this ticket
 * is forgotten.
 */

const MINIMAL_CONFIG = { version: CLI_CONFIG_VERSION };

describe("hostSettings schema (D11)", () => {
  it("parses a config with no hostSettings block at all, defaulting browserVideoPlane to null", () => {
    const result = cliConfigSchema.safeParse(MINIMAL_CONFIG);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.hostSettings).toEqual({ browserVideoPlane: null });
  });

  it("parses an empty hostSettings object, defaulting browserVideoPlane to null", () => {
    const result = cliConfigSchema.safeParse({
      ...MINIMAL_CONFIG,
      hostSettings: {},
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.hostSettings).toEqual({ browserVideoPlane: null });
  });

  it("round-trips an explicit stored choice, both true and false", () => {
    for (const browserVideoPlane of [true, false] as const) {
      const result = cliConfigSchema.safeParse({
        ...MINIMAL_CONFIG,
        hostSettings: { browserVideoPlane },
      });

      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(result.data.hostSettings).toEqual({ browserVideoPlane });
    }
  });

  it("strips an unknown key inside hostSettings without erroring", () => {
    const result = cliConfigSchema.safeParse({
      ...MINIMAL_CONFIG,
      hostSettings: {
        browserVideoPlane: true,
        // A field a future or hostile writer might add: zod's default
        // (non-strict) object behaviour silently drops it rather than
        // rejecting the whole config, which is what lets an OLDER binary
        // read a NEWER file's block without a version bump either way.
        someFutureFlag: "unexpected",
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.hostSettings).toEqual({ browserVideoPlane: true });
    expect(result.data.hostSettings).not.toHaveProperty("someFutureFlag");
  });

  it("rejects a non-boolean, non-null browserVideoPlane instead of coercing it", () => {
    const result = cliConfigSchema.safeParse({
      ...MINIMAL_CONFIG,
      hostSettings: { browserVideoPlane: "on" },
    });

    expect(result.success).toBe(false);
  });

  it("did not bump CLI_CONFIG_VERSION", () => {
    // The whole point of making the block additive/`.default()`-ed: adding it
    // must not force every existing config file through a migration. If this
    // ever fails, either the version was bumped unnecessarily or the wrong
    // constant is being read.
    expect(CLI_CONFIG_VERSION).toBe(1);
  });
});
