import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { CatalogueResponse } from "../src/shared/contracts.types";
import { subscriptionContext } from "../src/server/val-chat";
const catalogue = JSON.parse(
  readFileSync(new URL("../docs/build-pack/catalogue/catalogue.json", import.meta.url), "utf8"),
) as CatalogueResponse["catalogue"];
it.each(["creative", "learning", "gaming", "security", "reading"])(
  "supplies real product capabilities for %s without a demo brand script",
  (category) => {
    const service = catalogue.services.find((row) => row.category === category)!;
    expect(service).toBeTruthy();
    const context = subscriptionContext(catalogue.services, { serviceId: service.id, name: service.service });
    expect(context).toMatchObject({ identification: "matched", category, servicePurpose: service.purpose });
    expect(context.capabilities).toEqual(service.capability_tags.slice(0, 12));
  },
);
it("asks for clarification of an ambiguous merchant label rather than selecting a product", () => {
  const context = subscriptionContext(catalogue.services, { serviceId: "paypal:opaque", name: "Apple" });
  expect(context.identification).toBe("ambiguous");
  expect(context.category).toBe("subscription");
  expect(context.possibleProducts.length).toBeGreaterThan(1);
});
it("supports an unknown imported product without inventing capabilities, cost or a category", () => {
  const context = subscriptionContext(catalogue.services, {
    serviceId: "paypal:opaque",
    name: "Unlisted Studio Workspace",
  });
  expect(context).toMatchObject({
    identification: "unknown",
    capabilities: [],
    servicePurpose: null,
    category: "subscription",
  });
});
