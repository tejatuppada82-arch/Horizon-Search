import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { searchBrave } from "../src/brave-search.mjs";

test("renders hostile provider content as text without HTML sinks or script URLs", async () => {
  // The DOM double rejects any HTML sink, so a future innerHTML refactor fails.
  function element(tag) {
    return {
      tag, children: [], dataset: {}, value: "", textContent: "",
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {},
      querySelector() { return element("button"); },
      set innerHTML(value) { throw new Error("Untrusted HTML sink"); },
      set outerHTML(value) { throw new Error("Untrusted HTML sink"); },
      insertAdjacentHTML() { throw new Error("Untrusted HTML sink"); },
    };
  }
  const context = vm.createContext({
    document: {
      querySelector: () => element("div"), querySelectorAll: () => [],
      createElement: element,
    },
    location: { search: "" }, URLSearchParams,
    window: { addEventListener() {} },
  });
  const source = await readFile(new URL("../public/results.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  const attack = '<img src=x onerror="globalThis.compromised=true">';
  const { results } = await searchBrave("test", "test-token", async () => Response.json({
    web: { results: [
      { title: attack, description: "<script>globalThis.compromised=true</script>", url: "https://example.com/" },
      { title: "script", url: "javascript:globalThis.compromised=true" },
      { title: "data", url: "data:text/html,<script>alert(1)</script>" },
      { title: "file", url: "file:///etc/passwd" },
    ] },
  }));
  assert.equal(results.length, 1);
  context.result = results[0];
  const card = vm.runInContext('makeResultCard(result, "all")', context).children[0];
  const [, title, description] = card.children;
  assert.equal(title.textContent, attack);
  assert.equal(title.href, "https://example.com/");
  assert.equal(title.rel, "noopener noreferrer");
  assert.equal(description.textContent, "<script>globalThis.compromised=true</script>");
  assert.equal(vm.runInContext("globalThis.compromised", context), undefined);
});
