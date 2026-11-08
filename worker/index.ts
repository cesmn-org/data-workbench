interface Env {
  ASSETS: Fetcher;
  DATA_BUCKET: R2Bucket;
}

const OBJECT_PREFIX = "/api/objects/";
const ALLOWED_OBJECT_KEYS = new Set(["test/sample.parquet"]);

function objectKeyFromRequest(url: URL): string | null {
  if (!url.pathname.startsWith(OBJECT_PREFIX)) return null;

  const encodedKey = url.pathname.slice(OBJECT_PREFIX.length);
  if (!encodedKey || encodedKey.includes("..")) return null;

  try {
    return decodeURIComponent(encodedKey);
  } catch {
    return null;
  }
}

function objectHeaders(object: R2Object, size: number): Headers {
  const headers = new Headers();
  headers.set("accept-ranges", "bytes");
  headers.set("content-length", String(size));
  headers.set("content-type", object.httpMetadata?.contentType ?? "application/octet-stream");
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  if (object.httpMetadata?.cacheControl) headers.set("cache-control", object.httpMetadata.cacheControl);
  return headers;
}

function parseRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

async function serveObject(request: Request, bucket: R2Bucket, key: string): Promise<Response> {
  const metadata = await bucket.head(key);
  if (!metadata) return new Response("Not found", { status: 404 });

  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseRange(rangeHeader, metadata.size) : null;
  const headers = objectHeaders(metadata, range ? range.end - range.start + 1 : metadata.size);

  if (rangeHeader && !range) {
    headers.set("content-range", `bytes */${metadata.size}`);
    return new Response("Range Not Satisfiable", { status: 416, headers });
  }

  const object = range
    ? await bucket.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } })
    : await bucket.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${metadata.size}`);
  }

  return new Response(request.method === "HEAD" ? null : object.body, {
    status: range ? 206 : 200,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "data-workbench" });
    }

    if (url.pathname.startsWith(OBJECT_PREFIX)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }

      const key = objectKeyFromRequest(url);
      if (!key) return new Response("Invalid object key", { status: 400 });
      if (!ALLOWED_OBJECT_KEYS.has(key)) return new Response("Not found", { status: 404 });
      return serveObject(request, env.DATA_BUCKET, key);
    }

    return env.ASSETS.fetch(request);
  },
};
