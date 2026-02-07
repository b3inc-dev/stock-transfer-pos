#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "src", "ModalOutbound.jsx");
const content = fs.readFileSync(filePath, "utf8");
const lines = content.split("\n");
const out = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//")) continue;
  out.push(line);
}

fs.writeFileSync(filePath, out.join("\n"), "utf8");
console.log("Done. Removed full-line // comments only. Lines: " + lines.length + " -> " + out.length);
