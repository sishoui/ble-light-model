// 本地静态预览 site/（project-site.md §6）。零依赖：起一个只读文件服务器。
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteDir = join(__dirname, "..", "site");
const port = Number(process.env.PORT) || 4173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = join(siteDir, rel);
  if (existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  } else {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found: " + urlPath);
  }
}).listen(port, () => {
  console.log(`[site-preview] http://localhost:${port}/  （读 site/）`);
});