// Run: node --experimental-strip-types scripts/markdown.check.ts
import assert from "node:assert/strict";
import { toMarkdown, type MdNode } from "../src/markdown.ts";

const t = (s: string): MdNode => ({ nodeType: 3, nodeName: "#text", textContent: s, childNodes: [] });
const el = (name: string, kids: MdNode[] = [], className = ""): MdNode => ({ nodeType: 1, nodeName: name, textContent: null, childNodes: kids, className });

// What Chrome's contentEditable makes: the first line bare, later lines in divs, empty lines
// as <div><br></div>.
const note = el("ROOT", [
  t("Plan for "),
  el("B", [t("today ")]),
  t("and "),
  el("I", [t("tomorrow")]),
  el("DIV", [el("BR")]),
  el("H2", [t("Errands")]),
  el("UL", [el("LI", [t("milk")]), el("LI", [t("bread"), el("UL", [el("LI", [t("rye")])])])]),
  el("OL", [el("LI", [t("one")]), el("LI", [el("S", [t("two")])])]),
  el("UL", [el("LI", [t("call mum")], "done"), el("LI", [t("pay rent")])], "checks"),
  el("DIV", [el("U", [t("underlined")]), t(" end")]),
]);

assert.equal(
  toMarkdown(note),
  ["Plan for **today** and *tomorrow*", "", "## Errands", "- milk", "- bread", "  - rye", "1. one", "2. ~~two~~", "- [x] call mum", "- [ ] pay rent", "<u>underlined</u> end", ""].join("\n"),
);

// a list wrapped in a div, and blank runs collapsed
assert.equal(toMarkdown(el("ROOT", [el("DIV", [el("UL", [el("LI", [t("a")])])]), el("DIV", [el("BR")]), el("DIV", [el("BR")]), el("DIV", [el("BR")]), el("DIV", [t("b")])])), "- a\n\nb\n");
assert.equal(toMarkdown(el("ROOT", [])), "\n");

console.log("markdown checks passed");
