import { afterEach, describe, expect, it } from "vitest";
import { selectMediaObserverTargets } from "./mediaObserverScope.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function makeDoc(html: string): Document {
  // happy-dom doesn't ship a usable XMLHttpRequest path for parser-driven
  // doc creation, so we build a fresh document by hand and inject markup
  // through the body — same DOM shape the iframe document will have when
  // the runtime finishes mounting compositions.
  const doc = document.implementation.createHTMLDocument("test");
  doc.body.innerHTML = html;
  return doc;
}

describe("selectMediaObserverTargets", () => {
  it("returns the single root composition host", () => {
    const doc = makeDoc(`
      <div data-composition-id="root"></div>
    `);

    const targets = selectMediaObserverTargets(doc);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.getAttribute("data-composition-id")).toBe("root");
  });

  it("returns only top-level hosts when sub-composition hosts are nested", () => {
    // Mirrors the runtime structure: root host with a sub-composition host
    // mounted inside it. The nested host is already covered by the root
    // host's subtree observation.
    const doc = makeDoc(`
      <div data-composition-id="root">
        <div data-composition-id="sub-1"></div>
        <div>
          <div data-composition-id="sub-2"></div>
        </div>
      </div>
    `);

    const targets = selectMediaObserverTargets(doc);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.getAttribute("data-composition-id")).toBe("root");
  });

  it("returns multiple hosts when they are siblings (no shared ancestor host)", () => {
    const doc = makeDoc(`
      <div data-composition-id="comp-a"></div>
      <div data-composition-id="comp-b"></div>
    `);

    const targets = selectMediaObserverTargets(doc);

    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.getAttribute("data-composition-id"))).toEqual(["comp-a", "comp-b"]);
  });

  it("ignores attribute presence on intermediate non-host elements", () => {
    // Only `data-composition-id` is meaningful; an unrelated `data-composition`
    // attribute on a wrapper must not promote a nested host to top-level.
    const doc = makeDoc(`
      <div data-composition-id="root">
        <div data-composition="not-a-host">
          <div data-composition-id="sub"></div>
        </div>
      </div>
    `);

    const targets = selectMediaObserverTargets(doc);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.getAttribute("data-composition-id")).toBe("root");
  });

  it("falls back to the document body when no composition hosts exist", () => {
    // Documents that haven't been bootstrapped (or never will be) keep the
    // legacy behavior so adoption logic still runs against late additions.
    const doc = makeDoc(`<div class="not-a-composition"></div>`);

    const targets = selectMediaObserverTargets(doc);

    expect(targets).toEqual([doc.body]);
  });

  it("returns an empty array when neither hosts nor body are available", () => {
    // Synthetic edge case — guards the caller against attaching an observer
    // to `undefined` if the document is missing both signals. happy-dom
    // auto-fills `<body>`, so we hand-roll a minimal Document shape rather
    // than fight the runtime.
    const doc = {
      body: null,
      querySelectorAll: () => [],
    } as unknown as Document;

    const targets = selectMediaObserverTargets(doc);

    expect(targets).toEqual([]);
  });
});
