# Discovery catalogue

This runtime reference contains 200 service records across 10 categories, researched on 9 October 2026. It supports Discover browsing and initial product identification. It does not contain 200 financial integrations or guarantee current prices.

- [Catalogue](CATALOGUE.md): readable plan descriptions, prices, constraints and sources.
- [Structured records](catalogue.json), [schema](catalogue.schema.json) and [taxonomy](taxonomy.json).
- [Source register](source-register.json), [research exceptions](research-notes.md) and [validation](validation.json).

Records retain market, currency and purchase channel. Annual prices divided by twelve are comparison figures, not monthly payment options. Store prices can differ from direct billing. Student, business, introductory and other eligibility conditions remain part of the comparison; missing information stays unknown rather than becoming an inferred entitlement or exchange rate.

Use current provider evidence before quoting a saving or assuming a paid tier has a required capability. A shared category is insufficient proof of fit. Catalogue acceptance of PayPal would not grant account access, cancellation or migration authority. Execution is disabled for these records.

Run `node validate.mjs` from this directory to check the catalogue's structure, sources, counts, prices and disabled execution. This validates data conventions, not current provider availability. Logos have separate provenance and permissions; see [asset inventory](../../LICENSES.md).
