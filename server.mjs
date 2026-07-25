import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = 43821;
const root = fileURLToPath(new URL(".", import.meta.url));
const rootBoundary = normalize(root).replace(/[\\/]+$/, "") + sep;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${host}:${port}`).pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  const relative = pathname === "/" || pathname === "/callback" ? "index.html" : pathname.slice(1);
  const file = normalize(join(root, relative));

  if (!file.startsWith(rootBoundary)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const content = await readFile(file);
    response.writeHead(200, {
      "Content-Type": types[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(content);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, host, () => {
  console.log(`Spotify Lite est disponible sur http://${host}:${port}`);
});
