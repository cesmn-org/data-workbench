interface PlanTable {
  name: string;
  retainColumns: string[];
}

interface Env {
  ASSETS: Fetcher;
  DATA_BUCKET: R2Bucket;
  PLANS_DB: D1Database;
}

const OBJECT_PREFIX = "/api/objects/";
const UPLOAD_PATH = "/api/uploads";
const PLANS_PATH = "/api/plans";
const UPLOAD_TABLES = new Set(["tblVisits", "tblClientService", "tblClientInformation"]);
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function objectKeyFromRequest(url: URL): string | null {
  if (!url.pathname.startsWith(OBJECT_PREFIX)) return null;
  const encodedKey = url.pathname.slice(OBJECT_PREFIX.length);
  if (!encodedKey || encodedKey.includes("..")) return null;
  try { return decodeURIComponent(encodedKey); } catch { return null; }
}

function isAllowedObjectKey(key: string): boolean {
  const name = key.split("/").pop() ?? "";
  return /^\d{4}-\d{2}-\d{2}-\d{6}-ACCESS-(tblVisits|tblClientService|tblClientInformation)\.parquet$/.test(name);
}

function objectHeaders(object: R2Object, size: number): Headers {
  const headers = new Headers({ "accept-ranges": "bytes", "content-length": String(size), "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" });
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  if (object.httpMetadata?.cacheControl) headers.set("cache-control", object.httpMetadata.cacheControl);
  return headers;
}

function parseRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const requestedEnd = match[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start > requestedEnd || start >= size) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

async function serveObject(request: Request, bucket: R2Bucket, key: string): Promise<Response> {
  const metadata = await bucket.head(key);
  if (!metadata) return new Response("Not found", { status: 404 });
  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseRange(rangeHeader, metadata.size) : null;
  const headers = objectHeaders(metadata, range ? range.end - range.start + 1 : metadata.size);
  if (rangeHeader && !range) { headers.set("content-range", `bytes */${metadata.size}`); return new Response("Range Not Satisfiable", { status: 416, headers }); }
  const object = range ? await bucket.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } }) : await bucket.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${metadata.size}`);
  return new Response(request.method === "HEAD" ? null : object.body, { status: range ? 206 : 200, headers });
}

function utcTimestamp(date: Date): string { return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-"); }

async function isParquet(file: File): Promise<boolean> {
  if (file.size < 8) return false;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return new TextDecoder().decode(bytes.slice(0, 4)) === "PAR1" && new TextDecoder().decode(bytes.slice(-4)) === "PAR1";
}

async function uploadBatch(request: Request, bucket: R2Bucket): Promise<Response> {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) return jsonError("Expected multipart/form-data", 415);
  const form = await request.formData();
  const files = [...form.entries()].filter(([name, value]) => name === "file" && value instanceof File).map(([, value]) => value as File);
  if (!files.length) return jsonError("At least one Parquet file is required");
  if (files.some(file => file.size > MAX_UPLOAD_BYTES)) return jsonError("File exceeds upload limit", 413);
  const timestamp = utcTimestamp(new Date());
  const uploaded: { table: string; key: string; size: number }[] = [];
  for (const file of files) {
    const table = file.name.replace(/\.parquet$/i, "");
    if (!UPLOAD_TABLES.has(table) || !file.name.toLowerCase().endsWith(".parquet")) return jsonError(`Invalid table file: ${file.name}`);
    if (!(await isParquet(file))) return jsonError(`Invalid Parquet file: ${file.name}`);
    const key = `${timestamp}-ACCESS-${table}.parquet`;
    await bucket.put(key, file.stream(), { httpMetadata: { contentType: "application/vnd.apache.parquet" } });
    uploaded.push({ table, key, size: file.size });
  }
  return Response.json({ timestamp, objects: uploaded }, { status: 201 });
}

function parsePlan(row: Record<string, unknown>) {
  return { id: row.id, name: row.name, isDefault: Boolean(row.is_default), tables: JSON.parse(String(row.tables_json)) as PlanTable[], createdAt: row.created_at, updatedAt: row.updated_at };
}

async function plans(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const { results } = await env.PLANS_DB.prepare("SELECT * FROM plans ORDER BY is_default DESC, name").all();
    return Response.json(results.map(row => parsePlan(row as Record<string, unknown>)));
  }
  if (request.method !== "POST") return jsonError("Method Not Allowed", 405);
  const body = await request.json() as { name?: string; tables?: PlanTable[] };
  const name = body.name?.trim();
  if (!name || !Array.isArray(body.tables) || !body.tables.length) return jsonError("name and tables are required");
  if (body.tables.some(table => !table.name || !Array.isArray(table.retainColumns) || !table.retainColumns.length)) return jsonError("Invalid table selection");
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    await env.PLANS_DB.prepare("INSERT INTO plans (id,name,is_default,tables_json,created_at,updated_at) VALUES (?, ?, 0, ?, ?, ?)").bind(id, name, JSON.stringify(body.tables), now, now).run();
  } catch { return jsonError("A plan with that name already exists", 409); }
  return Response.json({ id, name, isDefault: false, tables: body.tables, createdAt: now, updatedAt: now }, { status: 201 });
}

async function planById(request: Request, env: Env, id: string): Promise<Response> {
  const existing = await env.PLANS_DB.prepare("SELECT * FROM plans WHERE id = ?").bind(id).first();
  if (!existing) return jsonError("Plan not found", 404);
  if (request.method === "DELETE") { await env.PLANS_DB.prepare("DELETE FROM plans WHERE id = ?").bind(id).run(); return new Response(null, { status: 204 }); }
  if (request.method === "PUT") {
    const body = await request.json() as { name?: string; tables?: PlanTable[] };
    const name = body.name?.trim();
    if (!name || !Array.isArray(body.tables) || !body.tables.length || body.tables.some(table => !table.name || !Array.isArray(table.retainColumns) || !table.retainColumns.length)) return jsonError("name and tables are required");
    const now = new Date().toISOString();
    await env.PLANS_DB.prepare("UPDATE plans SET name = ?, tables_json = ?, updated_at = ? WHERE id = ?").bind(name, JSON.stringify(body.tables), now, id).run();
    const updated = await env.PLANS_DB.prepare("SELECT * FROM plans WHERE id = ?").bind(id).first() as Record<string, unknown>;
    return Response.json(parsePlan(updated));
  }
  if (request.method !== "POST") return jsonError("Method Not Allowed", 405);
  await env.PLANS_DB.prepare("UPDATE plans SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ?").bind(id, new Date().toISOString()).run();
  const updated = await env.PLANS_DB.prepare("SELECT * FROM plans WHERE id = ?").bind(id).first() as Record<string, unknown>;
  return Response.json(parsePlan(updated));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true, service: "data-workbench" });
    if (url.pathname === UPLOAD_PATH) { if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } }); return uploadBatch(request, env.DATA_BUCKET); }
    if (url.pathname === PLANS_PATH) return plans(request, env);
    if (url.pathname.startsWith(`${PLANS_PATH}/`)) { const id = url.pathname.slice(`${PLANS_PATH}/`.length); if (!id || id.includes("/")) return jsonError("Invalid plan id"); return planById(request, env, id); }
    if (url.pathname.startsWith(OBJECT_PREFIX)) { if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } }); const key = objectKeyFromRequest(url); if (!key) return jsonError("Invalid object key"); if (!isAllowedObjectKey(key)) return new Response("Not found", { status: 404 }); return serveObject(request, env.DATA_BUCKET, key); }
    return env.ASSETS.fetch(request);
  },
};
