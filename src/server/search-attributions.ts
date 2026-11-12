import type { Response } from "openai/resources/responses/responses";

/** Only native search metadata is eligible, never model-generated HTML or links from prose. */
export function searchAttributions(responses: Pick<Response, "output">[]): string[] {
  return [
    ...new Set(
      responses.flatMap((response) =>
        response.output.flatMap((item) => {
          if (item.type !== "web_search_call") return [];
          const html = (item as unknown as { googleSearchSuggestions?: unknown }).googleSearchSuggestions;
          return typeof html === "string" && html.length > 0 && html.length <= 32768 ? [html] : [];
        }),
      ),
    ),
  ].slice(0, 32);
}
