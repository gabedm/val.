import type { ReactNode } from "react";

/** This deployment elects the low-volume Google Cloud omission option; see MODEL_COSTS.md.
 * Keep provider evidence available without embedding Search Suggestions, including saved HTML.
 */
export function SearchAttributions({ items, children }: { items?: string[]; children?: ReactNode }) {
  void items;
  if (!children) return null;
  return (
    <details className="search-attributions" aria-label="Research details">
      <summary>Research sources</summary>
      <div className="search-attributions-content">{children}</div>
    </details>
  );
}
