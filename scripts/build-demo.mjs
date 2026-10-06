/** Copy the library source into docs/lib so the GitHub Pages demo is self-contained. */
import { cpSync, rmSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dest = join(root, "docs", "lib");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

const count = readdirSync(dest).filter((f) => statSync(join(dest, f)).isFile()).length;
console.log(`Copied ${count} library files from src/ to docs/lib/`);
