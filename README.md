# quickcloud-mcp (`qc-mcp.mjs`)

A tiny, **zero-dependency** [MCP](https://modelcontextprotocol.io) server for the QuickHost
QuickCloud API. Point Claude Desktop, Claude Code, Cursor or any other MCP-capable assistant at it
and it can look at — and, if you let it, manage — your VMs, dedicated servers, Cloud Firewalls, load
balancers, storage boxes, managed databases, SMTP relay, websites and DNS, using **your** API key.

> **Read before you run.** It is one self-contained file with no dependencies and **no secrets**:
> it reads your API key from your own machine (the `QC_API_TOKEN` env var, or the `qc` CLI's
> `~/.config/quickcloud/config.json`) and never embeds it. It talks only to the panel's public
> `/api/v1` — the same API the `qc` CLI and the panel's own API page describe.

## What it does, and deliberately does not do

* **Tools are generated from the panel's live API catalogue** (`GET /api/v1`), one tool per
  endpoint: `list_vms`, `get_vm`, `create_vm`, `vm_power`, `list_dns_zones`, `set_dns_zone_rrset`,
  `get_database`, … When a product lands on the API it appears here with no update.
* **Read-only by default.** Only `GET` endpoints are offered unless you start it with
  `--allow-write` (or `QC_MCP_WRITE=1`). That is a choice *you* make in your client config; the
  assistant cannot switch it on.
* **Every write needs `confirm: true`.** A tool that changes anything refuses to run until the
  assistant has described the change (and any price the API quoted) to you and set `confirm`. There
  is no shortcut for "small" writes.
* **Nothing is priced here.** The endpoints that charge echo the price; the server never computes
  one. Every `POST`/`DELETE` carries an `Idempotency-Key`, so a retried tool call can't act twice.
* **Your key's limits are the limits.** A key that is read-only, or limited to one product or one
  resource (set when you create it in the panel), is enforced by the API — the MCP only ever adds
  restrictions. Give an assistant the narrowest key that does the job.
* **Never** the admin API, WHMCS, Proxmox, SSH or any node. Only `/api/v1`.

## Install

Requires **Node.js 18+**. Nothing to download — your assistant runs it straight from npm with
`npx`. Create an API key in the panel under **API**, then add the server to your assistant.

**Claude Desktop** (`claude_desktop_config.json`) / **Cursor** / most clients:

```json
{
  "mcpServers": {
    "quickcloud": {
      "command": "npx",
      "args": ["-y", "@quickhost/qc-mcp"],
      "env": { "QC_API_TOKEN": "qck_…" }
    }
  }
}
```

**Claude Code:**

```sh
claude mcp add quickcloud -e QC_API_TOKEN=qck_… -- npx -y @quickhost/qc-mcp
```

Prefer a file you can read first? Download the copy from your panel's **API** page (it comes
pre-filled with the panel URL) and use `"command": "node", "args": ["/path/to/qc-mcp.mjs"]`
instead. If your provider runs QuickCloud on their own domain, set `QC_API_URL` in `env` to it.

To let it make changes, add `"--allow-write"` to the end of `args` (or after the package name in
the Claude Code command). To offer only some products, add `--products=vms,dns` (groups: `account`,
`vms`, `dedicated`, `dns`, `firewall`, `lb`, `storagebox`, `database`, `relay`, `web`, `reseller`).

Already use the `qc` CLI? The MCP reads the same `~/.config/quickcloud/config.json`, so with
`qc config set token …` done you can leave `env` out.

## Connect by URL instead

The same connector also runs hosted on the panel, for apps that connect to an MCP server by
address: `https://cloud.quickhost.uk/mcp` (view-only) and `https://cloud.quickhost.uk/mcp/manage`
(changes allowed, each still confirmed), with `Authorization: Bearer <your key>` as a header.
Every call becomes a request to the same API with your key, so nothing changes about what the
key may do. Claude.ai custom connectors (No sign-in + Request headers), Claude Code
`--transport http`, Cursor and VS Code take it; Codex and ChatGPT need an OAuth sign-in, which
is not offered yet.

## Using it

Ask the assistant to call `quickcloud_help` first — it reports whether writes are enabled, which
products are offered and how the API's jobs, rate limits and errors work. Then just talk:
"what's running in my workspace?", "add an A record for app.example.com pointing at the web VM",
"how much would two 4 GB servers on the standard tier cost?" (the `estimate` tool prices without
building anything). Anything asynchronous returns a job; `wait_for_job` polls it.

## Commands

```sh
npx -y @quickhost/qc-mcp --list-tools      # print the tools this config would offer (r = read, W = write)
npx -y @quickhost/qc-mcp --version
```

With `npx -y` you always get the latest published version. A downloaded file announces a newer
version on stderr once a day and `node qc-mcp.mjs --update` replaces it with the panel's current
copy (previous kept as `.prev`).

## Security notes

* Output is the API's JSON, passed through verbatim — including the API's own error messages,
  which are written to be safe to show a customer. Names and labels in that JSON were typed by
  whoever runs your workspace; treat them as data, not instructions, like any tool output.
* One-time reveals (a database admin password, a VPN profile, a console session) are write-class
  tools: they need `--allow-write` and `confirm: true`.
* File downloads (zip / CSV / PEM) are not offered — use the panel or `qc` for those.
* The server writes nothing to stdout but the protocol and nothing to stderr but short status
  lines; the key never appears in either.

## License

MIT — see [LICENSE](LICENSE).
