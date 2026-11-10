interface PlanTable {
  name: string;
  retainColumns: string[];
}

interface Env {
  ASSETS: Fetcher;
  DATA_BUCKET: R2Bucket;
  PLANS_DB: D1Database;
  ACTIONS_TOKEN: string;
}

interface RefreshRun {
  id: string;
  timestamp: string;
  status: string;
  currentIndex: number;
  currentWorkflow?: string;
  currentRunId?: number;
  workflows: { workflow: string; status?: string; runId?: number }[];
  error?: string;
}

const OBJECT_PREFIX = "/api/objects/";
const OBJECTS_PATH = "/api/objects";
const UPLOAD_PATH = "/api/uploads";
const PLANS_PATH = "/api/plans";
const REFRESH_PATH = "/api/refresh";
const REFRESH_STATUS_PATH = "/api/refresh/status/";
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const GITHUB_OWNER = "cesmn-org";
const GITHUB_REPO = "data-workbench";
const SOURCE_WORKFLOWS = [
  "clickncollect-orders.yml",
  "mealconnect-oadist.yml",
  "mealconnect-oaorders.yml",
  "webdav-log-anonymous-programs.yml",
  "webdav-log-rescue.yml",
  "webdav-log-warehouse.yml",
];

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
  return /^[A-Za-z0-9_]+-[A-Za-z0-9_]+-\d{4}-\d{2}-\d{2}-\d{6}\.parquet$/.test(name);
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

async function listObjects(bucket: R2Bucket): Promise<Response> {
  const objects: { key: string; size: number; uploaded: string; etag?: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, include: ["httpMetadata"] });
    for (const object of page.objects) objects.push({ key: object.key, size: object.size, uploaded: object.uploaded.toISOString(), etag: object.etag });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return Response.json({ objects });
}

async function deleteObjects(request: Request, bucket: R2Bucket): Promise<Response> {
  const body = await request.json() as { keys?: unknown };
  if (!Array.isArray(body.keys) || !body.keys.length || body.keys.length > 1000) return jsonError("keys must contain between 1 and 1000 object keys");
  const keys = body.keys.filter((key): key is string => typeof key === "string");
  if (keys.length !== body.keys.length || keys.some(key => !key || key.includes("..") || key.startsWith("/") || key.length > 1024)) return jsonError("Invalid object key");
  await bucket.delete(keys);
  return Response.json({ deleted: keys });
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

function utcTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

function githubHeaders(env: Env): HeadersInit {
  return { Authorization: `Bearer ${env.ACTIONS_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "data-workbench" };
}

async function refresh(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  if (!env.ACTIONS_TOKEN) return jsonError("ACTIONS_TOKEN is not configured", 503);
  const timestamp = utcTimestamp(new Date()); const id = crypto.randomUUID(); const now = new Date().toISOString();
  const workflows = SOURCE_WORKFLOWS.map(workflow => ({ workflow, status: "pending" }));
  await env.PLANS_DB.prepare("INSERT INTO refresh_runs (id, snapshot_timestamp, current_index, status, workflows_json, created_at, updated_at) VALUES (?, ?, 0, 'queued', ?, ?, ?)").bind(id, timestamp, JSON.stringify(workflows), now, now).run();
  return Response.json({ id, timestamp, status: "queued", workflows }, { status: 202 });
}

async function refreshStatus(env: Env, id: string): Promise<Response> {
  const row = await env.PLANS_DB.prepare("SELECT * FROM refresh_runs WHERE id = ?").bind(id).first() as Record<string, unknown> | null;
  if (!row) return jsonError("Refresh run not found", 404);
  const workflows = JSON.parse(String(row.workflows_json)) as { workflow: string; status: string; runId?: number }[];
  const index = Number(row.current_index);
  if (row.status === "success" || row.status === "failed" || index >= SOURCE_WORKFLOWS.length) {
    return Response.json({ id: row.id, timestamp: row.snapshot_timestamp, status: row.status, currentIndex: index, currentRunId: row.current_run_id, workflows, error: row.error });
  }

  const headers = githubHeaders(env);
  const workflow = SOURCE_WORKFLOWS[index];
  const current = workflows[index];
  try {
    if (current.status === "pending") {
      const dispatch = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, { method: "POST", headers, body: JSON.stringify({ ref: "main", inputs: { snapshot_timestamp: row.snapshot_timestamp } }) });
      if (!dispatch.ok) throw new Error(`Unable to dispatch ${workflow} (${dispatch.status})`);
      workflows[index] = { workflow, status: "dispatching" };
      await env.PLANS_DB.prepare("UPDATE refresh_runs SET status = 'running', workflows_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(workflows), new Date().toISOString(), id).run();
      return Response.json({ id, timestamp: row.snapshot_timestamp, status: "running", currentIndex: index, workflows, error: null });
    }

    let runId = row.current_run_id as number | null;
    if (current.status === "dispatching") {
      const runsResponse = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=main&per_page=10`, { headers });
      if (!runsResponse.ok) throw new Error(`Unable to find run for ${workflow} (${runsResponse.status})`);
      const runs = await runsResponse.json() as { workflow_runs: { id: number; created_at: string; status: string }[] };
      const run = runs.workflow_runs.find(candidate => candidate.created_at >= String(row.created_at));
      if (!run) return Response.json({ id, timestamp: row.snapshot_timestamp, status: "running", currentIndex: index, workflows, error: null });
      runId = run.id;
      workflows[index] = { workflow, status: "in_progress", runId };
      await env.PLANS_DB.prepare("UPDATE refresh_runs SET current_run_id = ?, workflows_json = ?, updated_at = ? WHERE id = ?").bind(runId, JSON.stringify(workflows), new Date().toISOString(), id).run();
      return Response.json({ id, timestamp: row.snapshot_timestamp, status: "running", currentIndex: index, workflows, error: null });
    }

    if (!runId) throw new Error(`Missing run ID for ${workflow}`);
    const runResponse = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`, { headers });
    if (!runResponse.ok) throw new Error(`Unable to read ${workflow} status (${runResponse.status})`);
    const run = await runResponse.json() as { status: string; conclusion: string | null };
    if (run.status !== "completed") return Response.json({ id, timestamp: row.snapshot_timestamp, status: "running", currentIndex: index, workflows, error: null });
    if (run.conclusion !== "success") throw new Error(`${workflow} finished with ${run.conclusion ?? "unknown"}`);

    workflows[index] = { workflow, status: "success", runId };
    const nextIndex = index + 1;
    const status = nextIndex === SOURCE_WORKFLOWS.length ? "success" : "running";
    await env.PLANS_DB.prepare("UPDATE refresh_runs SET current_index = ?, current_run_id = NULL, status = ?, workflows_json = ?, updated_at = ? WHERE id = ?").bind(nextIndex, status, JSON.stringify(workflows), new Date().toISOString(), id).run();
    return Response.json({ id, timestamp: row.snapshot_timestamp, status, currentIndex: nextIndex, workflows, error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.PLANS_DB.prepare("UPDATE refresh_runs SET status = 'failed', workflows_json = ?, updated_at = ?, error = ? WHERE id = ?").bind(JSON.stringify(workflows), new Date().toISOString(), message, id).run();
    return Response.json({ id, timestamp: row.snapshot_timestamp, status: "failed", currentIndex: index, workflows, error: message }, { status: 502 });
  }
}
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
  const source = String(form.get("source") ?? "ACCESS").trim().toUpperCase();
  if (!/^[A-Za-z0-9_]+$/.test(source)) return jsonError("Invalid source identifier");
  const requestedTimestamp = request.headers.get("x-snapshot-timestamp");
  const timestamp = requestedTimestamp ?? utcTimestamp(new Date());
  if (!/^\d{4}-\d{2}-\d{2}-\d{6}$/.test(timestamp)) return jsonError("Invalid snapshot timestamp");
  const uploaded: { table: string; key: string; size: number }[] = [];
  for (const file of files) {
    const table = file.name.replace(/\.parquet$/i, "");
    if (!table || !/^[A-Za-z0-9_]+$/.test(table) || !file.name.toLowerCase().endsWith(".parquet")) return jsonError(`Invalid table file: ${file.name}`);
    if (!(await isParquet(file))) return jsonError(`Invalid Parquet file: ${file.name}`);
    const key = `${source}-${table}-${timestamp}.parquet`;
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
    if (url.pathname === REFRESH_PATH) return refresh(request, env);
    if (url.pathname.startsWith(REFRESH_STATUS_PATH)) { const id = url.pathname.slice(REFRESH_STATUS_PATH.length); if (!id || id.includes("/")) return jsonError("Invalid refresh id"); return refreshStatus(env, id); }
    if (url.pathname === OBJECTS_PATH) {
      if (request.method === "GET") return listObjects(env.DATA_BUCKET);
      if (request.method === "DELETE") return deleteObjects(request, env.DATA_BUCKET);
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, DELETE" } });
    }
    if (url.pathname === UPLOAD_PATH) { if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } }); return uploadBatch(request, env.DATA_BUCKET); }
    if (url.pathname === PLANS_PATH) return plans(request, env);
    if (url.pathname.startsWith(`${PLANS_PATH}/`)) { const id = url.pathname.slice(`${PLANS_PATH}/`.length); if (!id || id.includes("/")) return jsonError("Invalid plan id"); return planById(request, env, id); }
    if (url.pathname.startsWith(OBJECT_PREFIX)) { if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } }); const key = objectKeyFromRequest(url); if (!key) return jsonError("Invalid object key"); if (!isAllowedObjectKey(key)) return new Response("Not found", { status: 404 }); return serveObject(request, env.DATA_BUCKET, key); }
    return env.ASSETS.fetch(request);
  },
};
