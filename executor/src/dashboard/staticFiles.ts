/**
 * Path resolution for the monitor's static frontend.
 *
 * Split out of server.ts because that file starts listening on import: this is the part with a
 * security decision in it, and it should be testable without a socket.
 *
 * The decision: a request path is untrusted input, not a filename. `req.url` is the raw request
 * target and node:http does not normalise it. Browsers collapse `..` before sending, but nothing
 * requires a client to be a browser, and `GET /../../.env` joined onto the public directory walks
 * straight out of the tree and serves the environment file. Percent-encoding is decoded first for
 * the same reason: `%2e%2e%2f` is the same traversal in a costume.
 */
import { join, normalize, sep } from "node:path";

/**
 * Resolve a request path to an absolute path inside `publicDir`.
 *
 * @returns the absolute file path, or undefined when the request escapes the directory or is
 *          malformed. Undefined means 404; it never means "serve something else".
 */
export function resolvePublicFile(publicDir: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined; // malformed percent-encoding
  }

  // A NUL can truncate the path inside a syscall, so what the check sees and what the filesystem
  // opens would not be the same string.
  if (decoded.includes("\0")) return undefined;

  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const root = normalize(publicDir);
  const resolved = normalize(join(root, relative));

  // Compared on a separator boundary, so a sibling directory sharing the prefix (public-backup)
  // cannot pass as the public directory itself.
  if (resolved !== root && !resolved.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return undefined;
  }
  return resolved;
}
