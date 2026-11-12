# Dependency and asset licenses

Original Val application code uses [MIT](../LICENSE). Dependencies, fonts and brand marks retain their own terms; the application license does not grant rights to third-party material. Preserve their accompanying notices when redistributing applicable components.

## Direct dependencies

Versions below match the pinned application manifest. License identifiers come from package metadata and do not replace the packages' license texts.

| Package                             | Version        | License    |
| ----------------------------------- | -------------- | ---------- |
| `ajv`                               | 8.20.0         | MIT        |
| `@anthropic-ai/sdk`                 | 1.1.0          | Apache-2.0 |
| `ajv-formats`                       | 3.0.1          | MIT        |
| `cookie`                            | 2.0.1          | MIT        |
| `drizzle-orm`                       | 0.45.3         | Apache-2.0 |
| `express`                           | 5.2.1          | MIT        |
| `openai`                            | 7.27.0         | Apache-2.0 |
| `pg`                                | 8.23.1         | MIT        |
| `react` / `react-dom`               | 19.3.0         | MIT        |
| `tsx`                               | 4.23.15        | MIT        |
| `@types/express`                    | 5.0.6          | MIT        |
| `@types/node`                       | 26.6.4         | MIT        |
| `@types/pg`                         | 8.23.1         | MIT        |
| `@types/react` / `@types/react-dom` | 19.3.0         | MIT        |
| `@vitejs/plugin-react`              | 6.1.1          | MIT        |
| `drizzle-kit`                       | 0.31.11        | MIT        |
| `embedded-postgres`                 | 17.10.0-beta.17 | MIT        |
| `json-schema-to-typescript`         | 16.0.0         | MIT        |
| `prettier`                          | 3.9.9          | MIT        |
| `typescript`                        | 7.0.2          | Apache-2.0 |
| `vite`                              | 8.3.3          | MIT        |
| `vitest`                            | 5.0.3          | MIT        |

## Transitive and native components

Review the complete installed dependency tree for the release platform. Optional native packages differ by operating system. Relevant additional terms include Lightning CSS's MPL-2.0 and argparse's Python-2.0 license. Package metadata alone does not establish the rights or obligations of every bundled component.

The `@embedded-postgres/windows-x64` package separately attributes its binary distribution to the upstream embedded-postgres binaries under Apache-2.0, while its package code uses MIT. Preserve and review the applicable upstream notices before redistributing binaries. A source checkout ordinarily installs these dependencies through npm rather than bundling a local runtime.

## Fonts and visuals

Arimo is distributed under SIL Open Font License 1.1. Keep `docs/build-pack/assets/fonts/OFL.txt` with the font files.

Provider logo images are excluded. The interface uses plain service names. The PayPal login mark is loaded from PayPal's official asset URL; deployment operators must follow its applicable branding terms.

Inline interface glyphs live in `src/client/ui.tsx`. Product and service names identify their owners; no endorsement is implied.
