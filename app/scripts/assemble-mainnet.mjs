/**
 * Assemble the mainnet site: the landing page (app/landing/index.html) at the root and the mainnet
 * app, already built by Vite into dist-mainnet/app, under /app. Run by `npm run build:mainnet`.
 *
 * Refuses to finish if the landing page still carries an unfilled {{placeholder}}, or if the app was
 * built without its /app/ base (its assets would then resolve to the root and load the landing page).
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const landing = join(here, "landing", "index.html");
const out = join(here, "dist-mainnet");
const appIndex = join(out, "app", "index.html");

const fail = (msg) => { console.error(`assemble-mainnet: ${msg}`); process.exit(1); };
if (!existsSync(landing)) fail("app/landing/index.html not found.");
if (!existsSync(appIndex)) fail("dist-mainnet/app/index.html not found. Run the Vite build first.");
const page = readFileSync(landing, "utf8");
const left = page.match(/\{\{[A-Z0-9_]+\}\}/g);
if (left) fail(`the landing page has unfilled placeholders: ${[...new Set(left)].join(", ")}`);
if (!readFileSync(appIndex, "utf8").includes('="/app/assets/')) fail("the app was built without the /app/ base.");

copyFileSync(landing, join(out, "index.html"));
console.log("assemble-mainnet: landing page at /, mainnet app at /app");
