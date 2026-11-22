// The scratchpad's formatted note as Markdown, for saving to a file. Works on any DOM-like
// tree, so scripts/markdown.check.ts can feed it plain objects.

export type MdNode = { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<MdNode>; className?: string };

const kids = (n: MdNode) => Array.from(n.childNodes);
const BLOCKS = new Set(["DIV", "P", "H1", "H2", "H3", "UL", "OL", "LI", "BLOCKQUOTE"]);
const isBlock = (n: MdNode) => n.nodeType === 1 && BLOCKS.has(n.nodeName);

/** Markers outside the spaces: "** bold**" isn't bold in Markdown, " **bold**" is. */
function wrap(inner: string, mark: string) {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

function inline(n: MdNode): string {
  if (n.nodeType === 3) return (n.textContent ?? "").replace(/ /g, " ");
  if (n.nodeType !== 1) return "";
  const inner = kids(n).filter((c) => !isBlock(c)).map(inline).join("");
  switch (n.nodeName) {
    case "B":
    case "STRONG":
      return wrap(inner, "**");
    case "I":
    case "EM":
      return wrap(inner, "*");
    case "S":
    case "STRIKE":
    case "DEL":
      return wrap(inner, "~~");
    case "U":
      return inner.trim() ? `<u>${inner}</u>` : inner;
    case "BR":
      return "\n";
    default:
      return inner;
  }
}

function list(n: MdNode, indent: string, out: string[]) {
  const checks = (n.className ?? "").split(" ").includes("checks");
  let i = 0;
  for (const li of kids(n)) {
    if (li.nodeName !== "LI") continue;
    i++;
    const mark = checks ? `- [${(li.className ?? "").split(" ").includes("done") ? "x" : " "}] ` : n.nodeName === "OL" ? `${i}. ` : "- ";
    out.push(indent + mark + inline(li).trim());
    // A nested list sits inside its item, indented under it.
    for (const c of kids(li)) if (c.nodeName === "UL" || c.nodeName === "OL") list(c, indent + "  ", out);
  }
}

function blocks(n: MdNode, out: string[]) {
  let line = "";
  const flush = () => {
    if (line) out.push(...line.split("\n"));
    line = "";
  };
  for (const c of kids(n)) {
    if (!isBlock(c)) {
      line += inline(c);
      continue;
    }
    flush();
    if (c.nodeName === "UL" || c.nodeName === "OL") list(c, "", out);
    else if (/^H[1-3]$/.test(c.nodeName)) out.push(`${"#".repeat(+c.nodeName[1])} ${inline(c).trim()}`);
    else if (kids(c).some(isBlock)) blocks(c, out); // a line that wraps a list
    else out.push(...inline(c).replace(/\n$/, "").split("\n")); // <div><br></div> is an empty line
  }
  flush();
}

export function toMarkdown(root: MdNode): string {
  const out: string[] = [];
  blocks(root, out);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
