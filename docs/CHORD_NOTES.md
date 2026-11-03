# Chord platform notes (from api.chordhq.xyz/docs, read 3 Nov 2026)

Full docs: https://api.chordhq.xyz/docs · API reference: https://api.chordhq.xyz/docs/api · OpenAPI: https://api.chordhq.xyz/docs/api-reference/openapi.json

## Teammate = skills + tools + model + channel
- Create in app: Teammates → Create a teammate → upload skill files/folder/ZIP. Each folder with a `SKILL.md` (frontmatter: `name`, `description`) is one skill. Supporting files can sit in `references/` next to SKILL.md; paths in instructions must match.
- **Only published, included skills affect replies.** Save draft ≠ live. Use "Review and publish". A paused teammate also needs activation.
- "Why this reply" (admin) shows which skill versions and files a reply actually used — use it when debugging and cite it in field notes.
- In-app test conversation works without any channel. The WhatsApp simulator is a separate Connected App needing approval (Admin Panel → Connections → Connected Apps → Allow Approved Apps).

## Tools = remote MCP servers
- Chord is the MCP client. Server must speak **Streamable HTTP at a public HTTPS URL**; Chord POSTs JSON and accepts JSON or SSE responses. Private/loopback addresses are blocked → must be deployed (Vercel).
- Auth options: `none`, `bearer` (sent as `Authorization: Bearer …`), `api_key` (sent as `X-API-Key`), `oauth`. Use bearer.
- Register: `POST /v1/workspaces/{workspace_id}/mcp-servers` with `{name, url, auth_type, auth_token, transport: "streamable_http", enabled}` → returns `mcp-…` id. Or via UI: Teammate settings → Tools → Add tool.
- `enabled_tools`: exact tool names allowed; omitted/[] = all.
- Teammate scope: `mcp_server_ids` empty = all enabled servers in workspace. Set with `PUT /v1/teammates/{id}` `{"set_mcp_server_ids": ["mcp-…"]}`.
- Discovery: `POST …/mcp-servers/{id}/tools` (returns name, description, input_schema). Health: `POST …/{id}/health` → check `status` even on HTTP 200.
- A tool must be allowed for the teammate AND connected in the workspace (UI shows On / Off / Needs connecting).
- Registration success does not prove reachability — always run discovery + health, then a real chat turn.

## Built-in handoff
- On channel-bound conversations Chord offers the model a built-in `handover_to_human` tool. Calling it moves the thread from `agent_active` to `human_active`, logs a system turn, and notifies via the `conversation.escalated` webhook and/or the teammate's escalation email.
- Escalation triggers (text descriptions in teammate config) are the live path; stored escalation rules may be switched off server-side (`400 ESCALATION_RULES_DEPRECATED`).

## Scheduling (stretch: the "smart use of Chord")
- Recurring schedules: `POST /v1/teammates/{id}/schedules` with `task_prompt` and `cadence` (DAILY/WEEKLY, time_of_day, timezone) — output collects in one thread. Use for the owner's daily briefing.
- One-off tasks: `POST /v1/scheduled-tasks` with `task_type: "MESSAGE"` delivers a message into a conversation later (WhatsApp supported); `REPORT` runs the agent and you poll for the result. Use for promise-to-pay reminders.
- Needs an API key with `teammate:update`. Ask the account owner/TSG if your key lacks it — that request itself is worth a field note.

## Open questions to probe (record answers in FIELD_NOTES.md)
1. Does the MCP tool call carry the WhatsApp sender's number, or can the model see it? Log the full incoming MCP request body + headers on the first call.
2. Are all three skills applied at once, or is one chosen per reply by description? Check "Why this reply".
3. Credits consumed per simulator turn (50 total). Measure on the first exchange and budget tests.
4. Does `handover_to_human` appear in simulator conversations?
5. Can a scheduled `MESSAGE` task target a simulator conversation?
