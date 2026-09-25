import fs from "node:fs";
const md = fs.readFileSync("README.md", "utf8");
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
const anchors = new Set([...md.matchAll(/^#{2,3} (.+)$/gm)].map((m) => slug(m[1])));
const links = [...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
const bad = [...new Set(links)].filter((l) => !anchors.has(l));
console.log(bad.length ? `ANCHORS ROTOS: ${bad.join(", ")}` : `anchors: todos OK (${new Set(links).size} enlaces)`);
const fences = (md.match(/^```/gm) || []).length;
console.log("fences de codigo:", fences, fences % 2 === 0 ? "(balanceados)" : "(IMPARES: error)");
console.log("bloques mermaid:", (md.match(/^```mermaid/gm) || []).length);
console.log("alerts GitHub:", (md.match(/^> \[!/gm) || []).length);
console.log("tablas:", (md.match(/^\|---/gm) || []).length);
console.log("separadores ---:", (md.match(/^---$/gm) || []).length);
console.log("badges shields.io:", (md.match(/img\.shields\.io/g) || []).length);
console.log("lineas totales:", md.split("\n").length);
