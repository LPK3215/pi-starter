const { cpSync, rmSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const root = process.cwd();
const cmd = process.argv[2];

if (cmd === "clean") {
  rmSync(join(root, "dist"), { recursive: true, force: true });
  process.exit(0);
}

if (cmd === "copy") {
  const pairs = [
    ["src/prompts", "dist/prompts"],
    ["src/skills", "dist/skills"],
    ["src/knowledge", "dist/knowledge"],
  ];
  for (const [from, to] of pairs) {
    const src = join(root, from);
    if (!existsSync(src)) continue;
    cpSync(src, join(root, to), {
      recursive: true,
      filter: (srcPath) => !/\.(ts|js|map)$/.test(srcPath),
    });
  }
  process.exit(0);
}

console.error("usage: node scripts/dist-assets.cjs clean|copy");
process.exit(1);
