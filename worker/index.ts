interface Env {
  ASSETS: Fetcher;
  DATA_BUCKET: R2Bucket;
}

const OBJECT_PREFIX = "/api/objects/";
const UPLOAD_PATH = "/api/uploads";
const TABLES = new Set(["tblVisits", "tblClientService", "tblClientInformation"]);
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

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

function isAllowedObjectKey(key: string): boolean {
  const name = key.split("/").pop() ?? "";
  return /^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9-]+-(tblVisits|tblClientService|tblClientInformation)\.parquet$/.test(name);
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
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
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
  if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${metadata.size}`);
  return new Response(request.method === "HEAD" ? null : object.body, { status: range ? 206 : 200, headers });
}

function sourceSlug(sourceFileName: string): string | null {
  const base = sourceFileName.split(/[\\/]/).pop()?.replace(/\.(accdb|mdb)$/i, "") ?? "";
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || null;
}

function utcTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
}

async function isParquet(file: File): Promise<boolean> {
  if (file.size < 8) return false;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const start = new TextDecoder().decode(bytes.slice(0, 4));
  const end = new TextDecoder().decode(bytes.slice(-4));
  return start === "PAR1" && end === "PAR1";
}

async function uploadBatch(request: Request, bucket: R2Bucket): Promise<Response> {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    return Response.json({ error: "Expected multipart/form-data" }, { status: 415 });
  }
  const form = await request.formData();
  const source = form.get("sourceFileName");
  if (typeof source !== "string") return Response.json({ error: "sourceFileName is required" }, { status: 400 });
  const sourceName = sourceSlug(source);
  if (!sourceName) return Response.json({ error: "Invalid source filename" }, { status: 400 });
  const files = [...form.entries()]
    .filter(([name, value]) => name === "file" && value instanceof File)
    .map(([, value]) => value as File);
  if (!files.length) return Response.json({ error: "At least one Parquet file is required" }, { status: 400 });
  if (files.some(file => file.size > MAX_UPLOAD_BYTES)) return Response.json({ error: "File exceeds upload limit" }, { status: 413 });

  const timestamp = utcTimestamp(new Date());
  const uploaded: { table: string; key: string; size: number }[] = [];
  for (const file of files) {
    const table = file.name.replace(/\.parquet$/i, "");
    if (!TABLES.has(table) || !file.name.toLowerCase().endsWith(".parquet")) {
      return Response.json({ error: `Invalid table file: ${file.name}` }, { status: 400 });
    }
    if (!(await isParquet(file))) return Response.json({ error: `Invalid Parquet file: ${file.name}` }, { status: 400 });
    const key = `${timestamp}-${sourceName}-${table}.parquet`;
    await bucket.put(key, file.stream(), { httpMetadata: { contentType: "application/vnd.apache.parquet" } });
    uploaded.push({ table, key, size: file.size });
  }
  return Response.json({ timestamp, objects: uploaded }, { status: 201 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true, service: "data-workbench" });
    if (url.pathname === UPLOAD_PATH) {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > MAX_UPLOAD_BYTES * 4) return new Response("Upload too large", { status: 413 });
      return uploadBatch(request, env.DATA_BUCKET);
    }
    if (url.pathname.startsWith(OBJECT_PREFIX)) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      const key = objectKeyFromRequest(url);
      if (!key) return new Response("Invalid object key", { status: 400 });
      if (!isAllowedObjectKey(key)) return new Response("Not found", { status: 404 });
      return serveObject(request, env.DATA_BUCKET, key);
    }
    return env.ASSETS.fetch(request);
  },
};
