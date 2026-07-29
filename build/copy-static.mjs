import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const target = resolve(root, "public", "substation");

await rm(target, { recursive: true, force: true });
await mkdir(resolve(target, "assets"), { recursive: true });

await Promise.all([
  cp(resolve(root, "index.html"), resolve(target, "index.html")),
  cp(resolve(root, "scada-ui.css"), resolve(target, "scada-ui.css")),
  cp(resolve(root, "scada-ui.js"), resolve(target, "scada-ui.js")),
  cp(
    resolve(root, "assets", "kestrel-ridge-social.png"),
    resolve(target, "assets", "kestrel-ridge-social.png")
  ),
  cp(
    resolve(root, "assets", "kestrel-ridge-social.png"),
    resolve(root, "public", "og.png")
  ),
]);
