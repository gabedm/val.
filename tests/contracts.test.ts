import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatorFor } from "../src/shared/contracts";
import schema from "../src/shared/contracts.schema.json";

const examples = JSON.parse(readFileSync("docs/build-pack/contract-examples.json", "utf8")) as {
  valid: { definition: string; value: unknown }[];
  invalid: { definition: string; value: unknown; reason: string }[];
};

describe("shared contract schema", () => {
  it("compiles every named definition", () => {
    for (const definition of Object.keys(schema.$defs))
      expect(() => validatorFor(definition), definition).not.toThrow();
  });

  it.each(examples.valid.map((example) => [example.definition, example] as const))(
    "accepts the authored valid %s example",
    (_name, example) => {
      expect(validatorFor(example.definition)(example.value)).toBe(true);
    },
  );

  it.each(examples.invalid.map((example) => [`${example.definition}: ${example.reason}`, example] as const))(
    "rejects %s",
    (_name, example) => {
      expect(validatorFor(example.definition)(example.value)).toBe(false);
    },
  );
});
