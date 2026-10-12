#!/usr/bin/env node
// qc-mcp — the QuickCloud MCP server (docs/mcp-plan.md).
//
// A zero-dependency Model Context Protocol server (JSON-RPC 2.0 over stdio) that
// gives an AI assistant - Claude Desktop, Claude Code, Cursor, anything that
// speaks MCP - tools over the QuickCloud v1 API. It is a CLIENT of /api/v1 and
// nothing else: it authenticates with your own API key, so every rule the API
// enforces (workspace scoping, key capabilities and product scopes, pricing,
// rate limits) applies unchanged. The MCP only ever adds restrictions:
//
//   * READ-ONLY BY DEFAULT. Only GET endpoints are offered unless you start it
//     with --allow-write (or QC_MCP_WRITE=1). That is a choice YOU make in your
//     client config, once; the model cannot turn it on.
//   * EVERY WRITE NEEDS confirm:true. A mutating tool called without it answers
//     with an instruction to describe the change and ask you first.
//   * Idempotency-Key on every POST/DELETE, so a retried call never acts twice.
//   * Tools are generated from the panel's live catalogue (GET /api/v1), so a
//     product that lands on the API appears here with no update to this file.
//
// Quick start (Claude Desktop / Claude Code config):
//   {
//     "mcpServers": {
//       "quickcloud": {
//         "command": "node",
//         "args": ["/path/to/qc-mcp.mjs"],            // add "--allow-write" to let it change things
//         "env": { "QC_API_TOKEN": "qck_…" }           // or leave it to ~/.config/quickcloud/config.json (the qc CLI's file)
//       }
//     }
//   }
//
// Env: QC_API_URL (panel origin), QC_API_TOKEN (API key), QC_MCP_WRITE=1,
//      QC_MCP_PRODUCTS=vms,dns,… (offer only these catalogue groups).
// Flags: --allow-write, --products=a,b, --update, --version, --list-tools.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const VERSION = '1.1.0';   // 1.1.0: core exported for the panel's hosted /mcp endpoint (docs/remote-mcp-plan.md) - same tools, same rules; 1.0.1: MCP Registry listing (mcpName); 1.0.0: first release - tools generated from the v1 catalogue, read-only default, confirm on writes
const DEFAULT_URL = 'https://cloud.quickhost.uk';   // (the panel pre-fills this on download)
const CFG_DIR = path.join(os.homedir(), '.config', 'quickcloud');
const CFG_FILE = path.join(CFG_DIR, 'config.json');         // shared with the qc CLI
const VC_FILE = path.join(CFG_DIR, 'mcp-version-check.json');
const PROTOCOL = '2025-06-18';

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const flagVal = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };

function readCfg() { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return {}; } }
function cfg() {
  const c = readCfg();
  return {
    url: (process.env.QC_API_URL || c.url || DEFAULT_URL).replace(/\/+$/, ''),
    token: process.env.QC_API_TOKEN || c.token || '',   // never from argv: `ps` would show it
  };
}
const ALLOW_WRITE = flag('allow-write') || process.env.QC_MCP_WRITE === '1';
const PRODUCTS = (flagVal('products') || process.env.QC_MCP_PRODUCTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const log = (msg) => process.stderr.write(`[qc-mcp] ${msg}\n`);   // stderr only - stdout is the protocol channel

// ----------------------------------------------------------------------------
// API client
// ----------------------------------------------------------------------------
class ApiError extends Error { constructor(status, body) { super(body?.error?.message || `HTTP ${status}`); this.status = status; this.body = body; } }

// `client` = { url, token, headers? }. The stdio server uses cfg(); the panel's
// hosted endpoint passes the caller's own bearer per request (plan rule 2).
export async function api(method, p, { body, query, idem } = {}, client = cfg()) {
  const { url, token } = client;
  if (!token) throw new ApiError(401, { error: { code: 'no_api_key', message: 'No API key configured. Set QC_API_TOKEN in the MCP server env (create a key in the panel under API), or run `qc config set token <key>`.' } });
  const u = new URL(url + p);
  if (query && typeof query === 'object') for (const [k, v] of Object.entries(query)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': `qc-mcp/${VERSION}`, ...(client.headers || {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idem) headers['Idempotency-Key'] = idem;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    if (res.status === 429 && attempt < 4) {   // honour Retry-After, bounded
      const wait = Math.min(30, Math.max(1, Number(res.headers.get('retry-after')) || 2));
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('json')) {   // file downloads are not offered as tools; anything else non-JSON is an error
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new ApiError(res.status, { error: { code: 'http_error', message: `HTTP ${res.status}` } });
      return { non_json: true, content_type: ctype, bytes: text.length };
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, json);
    const out = json;
    if (res.headers.get('idempotency-replayed') === 'true') out._replayed = true;
    return out;
  }
}

// ----------------------------------------------------------------------------
// Catalogue → tools
// ----------------------------------------------------------------------------
const DOWNLOAD_RE = /\.(zip|csv|pem)$/;   // file bodies - never offered (a model can't use bytes; the CLI/panel can)
// GETs that reveal a one-time secret or mint a session: write-class (opt-in + confirm) even though they are GET.
const SECRET_GET_RE = /\/(profile|config|console|preview-token)$/;
const PRODUCT_GROUPS = {   // catalogue path prefix → group word for --products filtering + help
  workspace: 'account', estimate: 'account', clusters: 'account', templates: 'account', presets: 'vms', vms: 'vms', jobs: 'account', networks: 'vms', ips: 'account', rdns: 'account',
  dedicated: 'dedicated', dns: 'dns', firewalls: 'firewall', lbs: 'lb', 'storage-boxes': 'storagebox', databases: 'database', relay: 'relay', websites: 'web', reseller: 'reseller',
};

function singular(seg) {
  if (/(ss|us|is)$/.test(seg) || !/s$/.test(seg)) return seg;
  if (/(x|ch|sh|ss)es$/.test(seg) || /sses$/.test(seg)) return seg.slice(0, -2);
  return seg.slice(0, -1);
}
export function toolNameFor(method, apiPath) {
  const segs = apiPath.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean);
  const words = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (/^\{.*\}$/.test(s)) continue;
    const next = segs[i + 1];
    words.push((next && /^\{.*\}$/.test(next) ? singular(s) : s).replace(/[^a-z0-9]+/gi, '_').toLowerCase());
  }
  const last = segs[segs.length - 1];
  const lastIsParam = /^\{.*\}$/.test(last);
  const lastLit = [...segs].reverse().find((s) => !/^\{.*\}$/.test(s)) || '';
  // A plural last literal is a collection (list / create); 'dns', 'rdns', 'status' are not.
  const plural = !lastIsParam && /s$/.test(lastLit) && !/(ss|us|is)$/.test(lastLit) && !['dns', 'rdns'].includes(lastLit);
  const noun = words.join('_') || 'root';
  switch (method) {
    case 'GET': return plural ? `list_${noun}` : `get_${noun}`;
    case 'POST':
      if (lastIsParam) return `set_${noun}`;
      if (plural) { const w = [...words]; w[w.length - 1] = singular(w[w.length - 1]); return `create_${w.join('_')}`; }
      return noun;   // an action: vm_power, website_publish, dedicated_stock_buy
    case 'PUT': return `set_${noun}`;
    case 'PATCH': return `update_${noun}`;
    case 'DELETE': return `delete_${noun}`;
    default: return `${method.toLowerCase()}_${noun}`;
  }
}

const TYPE_RE = /^\s*(integer|boolean|array|object|number)\b/i;
function propFor(desc) {
  const d = String(desc || '');
  const m = d.match(TYPE_RE);
  const type = m ? m[1].toLowerCase() : 'string';
  const p = { type, description: d.slice(0, 600) };
  if (type === 'array') p.items = {};
  if (type === 'object') p.additionalProperties = true;
  return p;
}

export function buildTools(catalogue, { allowWrite = false, products = [] } = {}) {
  const tools = []; const seen = new Map();
  for (const e of catalogue.endpoints || []) {
    if (DOWNLOAD_RE.test(e.path)) continue;
    const first = e.path.replace(/^\/api\/v1\/?/, '').split('/')[0];
    const group = PRODUCT_GROUPS[first] || first;
    if (products.length && !products.includes(group)) continue;
    const isWrite = e.method !== 'GET' || SECRET_GET_RE.test(e.path);
    if (isWrite && !allowWrite) continue;
    let name = toolNameFor(e.method, e.path);
    if (seen.has(name)) name = `${name}_${e.method.toLowerCase()}`;
    if (seen.has(name)) { let n = 2; while (seen.has(`${name}_${n}`)) n++; name = `${name}_${n}`; }
    const params = [...e.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const properties = {}; const required = [];
    for (const p of params) { properties[p] = { type: 'string', description: `Path parameter {${p}}` }; required.push(p); }
    if (e.body && typeof e.body === 'object') for (const [k, v] of Object.entries(e.body)) if (!properties[k]) properties[k] = propFor(v);
    if (e.method === 'GET') properties.query = { type: 'object', description: 'Optional query-string parameters (e.g. { "list": "newsletter" }).', additionalProperties: { type: 'string' } };
    if (isWrite) properties.confirm = { type: 'boolean', description: 'REQUIRED for this tool to act. Only set true after you have described exactly what will change (and any price the API quoted) to the person and they have agreed.' };
    let desc = `${e.method} ${e.path} — ${e.summary}`;
    if (e.capability) desc += ` Requires API-key capability ${e.capability}.`;
    if (isWrite) desc += ' CHANGES STATE: needs confirm:true (ask the person first).';
    if (e.method === 'GET' && SECRET_GET_RE.test(e.path)) desc += ' Reveals a one-time secret / mints a session.';
    const tool = { name, description: desc.slice(0, 1024), inputSchema: { type: 'object', properties, additionalProperties: false } };
    if (required.length) tool.inputSchema.required = required;
    tool.annotations = { title: name, readOnlyHint: !isWrite, destructiveHint: e.method === 'DELETE' || /(release|reinstall|rollback|unpublish|restore|reset|disarm|wipe)$/.test(e.path), idempotentHint: e.method === 'GET' || e.method === 'PUT' };
    seen.set(name, { e, params, isWrite, group });
    tools.push(tool);
  }
  // Hand-written conveniences (the only ones).
  tools.push({
    name: 'wait_for_job', description: 'Poll GET /api/v1/jobs/{id} every 1.5 s until the job is done or failed (create / power / resize / delete are asynchronous and return a job). Then read the resource back (e.g. get_vm) for its address.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Job id from an async response' }, timeout_s: { type: 'integer', description: 'Give up after this many seconds (default 300, max 600)' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  });
  tools.push({
    name: 'quickcloud_help', description: 'How this QuickCloud connection works: auth, rate limits, idempotency, async jobs, error shape, whether writes are enabled and which products are offered. Read this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true },
  });
  return { tools, index: seen };
}

// ----------------------------------------------------------------------------
// Tool execution
// ----------------------------------------------------------------------------
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const errText = (obj) => ({ ...text(obj), isError: true });

// state = { catalogue, tools, index, allowWrite, panel, waitCapS?, modeText? } - see mcpState().
export async function callTool(state, name, args, client = cfg()) {
  args = args && typeof args === 'object' ? args : {};
  if (name === 'quickcloud_help') {
    const c = state.catalogue;
    return text({
      server: `qc-mcp ${VERSION}`, panel: state.panel, mode: state.modeText || (state.allowWrite ? 'writes allowed (every write still needs confirm:true)' : 'READ-ONLY (start the server with --allow-write to enable changes)'),
      products_offered: [...new Set([...state.index.values()].map((v) => v.group))], tools: state.tools.length,
      auth: c.auth, rate_limit: c.rate_limit, idempotency: c.idempotency, async: c.async, errors: c.errors,
      rules: ['Describe any change and its price to the person before setting confirm:true.', 'Never guess an id - list first.', 'After an async call, use wait_for_job then read the resource back.'],
    });
  }
  if (name === 'wait_for_job') {
    const id = String(args.id || '').trim();
    if (!/^\d+$/.test(id)) return errText({ error: { code: 'invalid_request', message: 'id must be a numeric job id' } });
    const cap = state.waitCapS || 600;
    const timeout = Math.min(cap, Math.max(5, Number(args.timeout_s) || Math.min(300, cap))) * 1000;
    const started = Date.now();
    for (;;) {
      let r; try { r = await api('GET', `/api/v1/jobs/${id}`, {}, client); } catch (e) { return errText(e.body || { error: { message: e.message } }); }
      const st = r?.job?.status;
      if (st === 'done' || st === 'failed') return st === 'failed' ? errText(r) : text(r);
      if (Date.now() - started > timeout) return errText({ error: { code: 'timeout', message: `job ${id} still ${st || 'pending'} after ${timeout / 1000}s - poll again with wait_for_job` }, job: r?.job });
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  const t = state.index.get(name);
  if (!t) return errText({ error: { code: 'unknown_tool', message: `no tool named ${name}` } });
  if (t.isWrite && args.confirm !== true) {
    return errText({ error: { code: 'confirmation_required', message: `${name} changes state. Describe exactly what will change (and any price involved) to the person, and call again with confirm:true only once they have agreed.` } });
  }
  let p = t.e.path;
  for (const k of t.params) {
    const v = args[k];
    if (v == null || v === '') return errText({ error: { code: 'invalid_request', message: `missing path parameter ${k}` } });
    p = p.replace(`{${k}}`, encodeURIComponent(String(v)));
  }
  const body = {};
  for (const [k, v] of Object.entries(args)) if (!t.params.includes(k) && k !== 'confirm' && k !== 'query') body[k] = v;
  const hasBody = t.e.method !== 'GET' && Object.keys(body).length > 0;
  const idem = (t.e.method === 'POST' || t.e.method === 'DELETE') ? randomUUID() : undefined;
  try {
    const r = await api(t.e.method, p, { body: hasBody ? body : (t.e.method === 'GET' ? undefined : {}), query: t.e.method === 'GET' ? args.query : undefined, idem }, client);
    return text(r);
  } catch (e) {
    return errText(e.body && typeof e.body === 'object' ? { status: e.status, ...e.body } : { error: { code: 'request_failed', message: e.message } });
  }
}

// Build the per-mode state both entries use. `catalogue` = the GET /api/v1 body.
export function mcpState(catalogue, { allowWrite = false, products = [], panel = '', waitCapS = 600, modeText = null } = {}) {
  return { catalogue, ...buildTools(catalogue, { allowWrite, products }), allowWrite, panel, waitCapS, modeText };
}
export function initializeResult(state) {
  return { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'quickcloud', version: VERSION }, instructions: `QuickCloud (${state.panel}) via its v1 API. ${state.allowWrite ? 'Writes are enabled but EVERY write tool needs confirm:true - describe the change and any price to the person and get their agreement first.' : 'This connection is READ-ONLY.'} Call quickcloud_help first. Never guess ids - list, then act. Async calls return a job: use wait_for_job, then read the resource back.` };
}
export { text as mcpText, errText as mcpErrText, VERSION as MCP_VERSION };

// ----------------------------------------------------------------------------
// MCP over stdio (JSON-RPC 2.0, newline-delimited)
// ----------------------------------------------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
const rpcError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function loadCatalogue() {
  const { url } = cfg();
  const res = await fetch(url + '/api/v1', { headers: { Accept: 'application/json', 'User-Agent': `qc-mcp/${VERSION}` } });
  if (!res.ok) throw new Error(`GET ${url}/api/v1 → HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j.endpoints)) throw new Error(`${url}/api/v1 did not return a catalogue`);
  return j;
}

async function serve() {
  let state = { catalogue: null, tools: [], index: new Map(), allowWrite: ALLOW_WRITE, panel: cfg().url };
  try {
    state = mcpState(await loadCatalogue(), { allowWrite: ALLOW_WRITE, products: PRODUCTS, panel: cfg().url });
    log(`${state.tools.length} tools from ${cfg().url} (${ALLOW_WRITE ? 'writes allowed, confirm required' : 'read-only'})`);
  } catch (e) {
    log(`could not load the API catalogue: ${e.message} - check QC_API_URL`);
  }
  maybeNotifyUpdate().catch(() => {});
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) handle(line).catch((e) => log(`handler error: ${e.message}`));
    }
  });
  process.stdin.on('end', () => process.exit(0));

  async function handle(line) {
    let msg; try { msg = JSON.parse(line); } catch { return rpcError(null, -32700, 'parse error'); }
    const { id, method, params } = msg;
    if (method == null) return;                        // a response to something we never sent
    if (id === undefined) {                            // notification
      if (method === 'notifications/initialized') log('client connected');
      return;
    }
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: initializeResult(state) });
      case 'ping': return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        if (!state.catalogue) { try { state = mcpState(await loadCatalogue(), { allowWrite: ALLOW_WRITE, products: PRODUCTS, panel: cfg().url }); } catch (e) { return rpcError(id, -32000, `catalogue unavailable: ${e.message}`); } }
        return send({ jsonrpc: '2.0', id, result: { tools: state.tools } });
      case 'tools/call': {
        if (!state.catalogue) return send({ jsonrpc: '2.0', id, result: errText({ error: { code: 'unavailable', message: 'the API catalogue could not be loaded - check QC_API_URL' } }) });
        const name = String(params?.name || '');
        const result = await callTool(state, name, params?.arguments);
        return send({ jsonrpc: '2.0', id, result });
      }
      case 'resources/list': return send({ jsonrpc: '2.0', id, result: { resources: [] } });
      case 'resources/templates/list': return send({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } });
      case 'prompts/list': return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      case 'logging/setLevel': return send({ jsonrpc: '2.0', id, result: {} });
      default: return rpcError(id, -32601, `method not found: ${method}`);
    }
  }
}

// ----------------------------------------------------------------------------
// Update check / self-update (the qc CLI's idiom)
// ----------------------------------------------------------------------------
function semverGt(a, b) { const A = a.split('.').map(Number), B = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((A[i] || 0) > (B[i] || 0)) return true; if ((A[i] || 0) < (B[i] || 0)) return false; } return false; }
async function latestVersion(force = false) {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(VC_FILE, 'utf8')); } catch { /* none yet */ }
  const ttl = cache.latest && semverGt(cache.latest, VERSION) ? 86400000 : 3600000;
  if (!force && cache.checkedAt && Date.now() - cache.checkedAt < ttl) return cache.latest || null;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(cfg().url + '/api/mcp/version', { signal: ctrl.signal }); clearTimeout(t);
    const j = await res.json().catch(() => ({}));
    const latest = /^\d+\.\d+\.\d+$/.test(String(j?.version || '')) ? j.version : null;
    try { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(VC_FILE, JSON.stringify({ checkedAt: Date.now(), latest })); } catch { /* ignore */ }
    return latest;
  } catch { return cache.latest || null; }
}
async function maybeNotifyUpdate() {
  const latest = await latestVersion();
  if (latest && semverGt(latest, VERSION)) log(`a newer qc-mcp is available (${VERSION} → ${latest}): node ${process.argv[1]} --update`);
}
async function cmdUpdate() {
  const self = fs.realpathSync(process.argv[1]);
  const { url } = cfg();
  const latest = await latestVersion(true);
  if (!latest) { log(`could not reach ${url}/api/mcp/version`); process.exit(1); }
  if (!flag('force') && !semverGt(latest, VERSION)) { log(`qc-mcp ${VERSION} is up to date (panel offers ${latest})`); return; }
  const res = await fetch(url + '/api/mcp/qc-mcp.mjs');
  if (!res.ok) { log(`download failed: HTTP ${res.status}`); process.exit(1); }
  const src = await res.text();
  const m = src.match(/const VERSION = '([^']+)'/);
  if (!m) { log('the download does not look like qc-mcp (no VERSION line) - not installed'); process.exit(1); }
  const tmp = path.join(path.dirname(self), `.qc-mcp.${process.pid}.tmp.mjs`);
  try { fs.writeFileSync(tmp, src, { mode: 0o755 }); } catch (e) { log(`cannot write to ${path.dirname(self)} (${e.code}) - update by hand: curl -fsSL ${url}/api/mcp/qc-mcp.mjs -o ${self}`); process.exit(1); }
  const chk = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  if (chk.status !== 0) { try { fs.unlinkSync(tmp); } catch { /* */ } log(`the downloaded file does not parse - not installed`); process.exit(1); }
  try { fs.copyFileSync(self, self + '.prev'); fs.renameSync(tmp, self); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* */ } log(`could not replace ${self} (${e.code})`); process.exit(1); }
  log(`updated qc-mcp ${VERSION} → ${m[1]} at ${self} (previous copy kept as .prev)`);
}

// ----------------------------------------------------------------------------
// Entry
// ----------------------------------------------------------------------------
let isMain = false;
try { isMain = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported from a test */ }
if (isMain) {
  if (flag('version')) { process.stdout.write(`qc-mcp ${VERSION}\n`); }
  else if (flag('update')) { await cmdUpdate(); }
  else if (flag('list-tools')) {
    const c = await loadCatalogue();
    const { tools } = buildTools(c, { allowWrite: ALLOW_WRITE, products: PRODUCTS });
    for (const t of tools) process.stdout.write(`${t.annotations?.readOnlyHint ? 'r' : 'W'}  ${t.name}\n`);
    process.stdout.write(`${tools.length} tools (${ALLOW_WRITE ? 'writes allowed' : 'read-only'})\n`);
  } else await serve();
}
