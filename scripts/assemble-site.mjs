/**
 * Assemble the public web output: the landing page at the root, the operator app under /app.
 *
 * One host and one deploy, so the landing page links the app with a relative path rather than a
 * jump to another domain. It does not change the app's relationship to the write API, which lives
 * on a host that can keep a process alive and is cross-origin either way.
 *
 * Run through `npm run build:web`, which builds the app first. This step only copies.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const landing = join(root, "site", "index.html");
const appDist = join(root, "app", "dist");

if (!existsSync(landing)) {
  console.error("assemble-site: site/index.html not found.");
  process.exit(1);
}
if (!existsSync(appDist)) {
  console.error("assemble-site: app/dist not found. Run the app build first (npm run build:web).");
  process.exit(1);
}

// Start clean, so a file deleted from a source directory cannot survive in the output.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(landing, join(out, "index.html"));
cpSync(appDist, join(out, "app"), { recursive: true });

/** Every file in the output, for a build log that shows what actually shipped. */
function walk(dir, prefix = "") {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) found.push(...walk(full, rel));
    else found.push({ path: rel, bytes: statSync(full).size });
  }
  return found;
}

const files = walk(out);
console.log(`assemble-site: ${files.length} file(s) in dist/`);
for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
  console.log(`  ${(f.bytes / 1024).toFixed(1).padStart(8)} kB  ${f.path}`);
}

// The app's asset URLs are absolute from /app/. If the bundle was built without that base, every
// asset request would resolve to the root and return the landing page's HTML instead.
const appIndex = join(out, "app", "index.html");
if (!existsSync(appIndex)) {
  console.error("\nassemble-site: app/index.html missing from the output.");
  process.exit(1);
}
if (!readFileSync(appIndex, "utf8").includes('="/app/assets/')) {
  console.error(
    "\nassemble-site: the app bundle does not reference /app/assets/. It was built without the\n" +
      "correct base, so its assets would resolve to the root and return the landing page's HTML\n" +
      "instead of JavaScript. Build with `npm run build:web`.",
  );
  process.exit(1);
}

console.log("\nassemble-site: landing page at /, operator app at /app");
