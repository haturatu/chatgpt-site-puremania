import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const outfile = "public/static/js/app-bundle.js";
await build({
  entryPoints: ["public/static/js/app.js"],
  outfile,
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  external: ["codemirror", "@codemirror/*", "@replit/*"],
});

const bundle = await readFile(outfile);
const version = createHash("sha256").update(bundle).digest("hex").slice(0, 12);
const indexPath = "public/static/index.html";
const index = await readFile(indexPath, "utf8");
await writeFile(indexPath, index.replace(/([?&]v=)[^'"&]+/g, "$1" + version));
console.log("Built the Pure Mania browser app with asset version " + version);
