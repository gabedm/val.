import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChatReplyProgress, ResearchProgress } from "../src/client/ValConversation";

it("names the current check without a noisy counter or invented completion percentage", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchProgress, {
      waiting: false,
      progress: { name: "A different service", checked: 2, total: 7 },
    }),
  );
  expect(html).toContain("Checking A different service…");
  expect(html).not.toContain("2 of 7");
  expect(html).not.toContain("<progress");
});

it("does not invent a completion percentage before a batch starts or during a rate pause", () => {
  const pending = renderToStaticMarkup(createElement(ResearchProgress, { waiting: false, progress: null }));
  expect(pending).toContain("Checking provider offers…");
  expect(pending).not.toContain("<progress");
  const paused = renderToStaticMarkup(
    createElement(ResearchProgress, { waiting: true, progress: { name: "A service", checked: 0, total: 5 } }),
  );
  expect(paused).toContain("Taking a short pause, then continuing…");
  expect(paused).not.toContain("<progress");
});

it("explains a delayed reply without claiming research or progress that did not happen", () => {
  const initial = renderToStaticMarkup(createElement(ChatReplyProgress));
  expect(initial).toContain('class="sr-only">Val is replying');
  const delayed = renderToStaticMarkup(createElement(ChatReplyProgress, { delayed: true }));
  expect(delayed).toContain('role="status"');
  expect(delayed).toContain("I’m still working on your reply…");
  expect(delayed).not.toContain('class="sr-only"');
  expect(delayed).not.toContain("<progress");
  expect(delayed).not.toContain("Checking provider offers");
});
