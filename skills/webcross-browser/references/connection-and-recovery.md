# Connection and recovery

Use the section for the active connection. Obtain endpoints, runtime locations,
and authentication instructions from WebCross or the existing connection
configuration.

## Establish or reuse a connection

Preserve the user's selected environment and connection. Reuse valid identity
and recovery state belonging to that environment.

Transport authentication and Agent registration are separate steps. Complete
registration before browser Actions or event operations. The CLI handles
registration during command startup. For MCP and WebSocket, follow the active
transport's registration instructions.

Discover callable Actions and visible events from the current catalogs.
Describe unfamiliar operations on demand. Refresh the affected contracts when
catalogRevision or eventCatalogRevision changes.

guideRevision covers the Browser Skill and its bundled references. When it
changes, refresh the Browser Skill and the references needed by the task.

## Initial connection preparation

An invitation asks the Agent to connect, register, read the capability and event catalogs,
and save its identity, event cursor, and catalog revisions. Report the connection as ready only
when these steps succeed; otherwise report the failed step and the service's reason. Do not
operate pages or start browser instances during preparation. Establish event listening only when
a later task needs it. For modern MCP, preserve the returned eventsResourceUri for that task.

## CLI

If WebCross is closed, run `webcross launch` locally.
Connect once the command reports readiness.

For unauthenticated use, omit --agent-id and --profile on the first call.
Save agentId and eventCursor from session.ready.data. Pass --agent-id on later
calls to reuse that identity. Omitting it creates another identity.

agentId is a routing handle, not a credential. Do not share it between
independent Agents. It cannot be combined with --profile or ABCP_PROFILE.

For paired use, follow the invitation supplied by WebCross. webcross pair
reads the invitation from stdin. Reuse the resulting Profile through --profile
when required. Keep invitation and credential contents out of command arguments,
ordinary configuration, and logs.

Use webcross actions list for the Action directory and
webcross actions describe <Action.name> for details.
Use webcross System.listEvents and webcross System.describeEvent for events.

For Actions requiring a purpose, use --purpose <text> or the top-level purpose
field in --params JSON; --purpose takes precedence when both are supplied.

Use NDJSON output for automation. Parse each stdout line independently and
dispatch by type: session.ready, result, event, or error. A command can emit
session.ready before an error. events watch continues emitting event records.

The CLI does not persist Agent identity or event cursors. Supply the saved
cursor through --from when recovering with events read. Without --from,
events read starts from the session baseline. events watch does not save a
checkpoint.

## MCP

Use the endpoint supplied by WebCross and the exact tool names and schemas
returned by tools/list. Request unfamiliar Action details through the current
system_describe_action tool.

The endpoint supports legacy 2025-11-25 and modern 2026-07-28 connections.
Follow the negotiated version.

### Modern MCP

Modern MCP does not use initialize or Mcp-Session-Id. Use the protocol metadata
and request headers required by the active client.

Send the Bearer header on every authenticated request. Without authentication,
call system_register, save agentId, and pass agentId or its contextId alias on
later tool calls. When both are present, they must match.

The complete tool directory is available before registration. Register before
business calls; do not wait for a registration-related directory update.

Save eventsResourceUri from registration. When a task needs event listening, use
subscriptions/listen with notifications.resourceSubscriptions and declare the client capabilities
actually supported. A resource update indicates that
newer events may exist. Recover and consume the event sequence with
abcp_read_events from the saved cursor.

After a broken listener, listen again and recover from the saved cursor.
If an unauthenticated identity expires, register again according to the server's
response. An open listener does not keep that identity valid indefinitely.

### Modern registration request (`2026-07-28`)

Read the actual endpoint from `url` in MCP mode, `mcp.url` in authenticated automatic mode,
or `endpoints.mcpEndpoint` when authentication is disabled. Send this HTTP POST to that endpoint:

```http
Accept: application/json, text/event-stream
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: system_register
```

When authentication is enabled, also send the supplied `headers.Authorization` unchanged on every
request (`mcp.headers.Authorization` in automatic mode). Omit it when authentication is disabled.
Never put credentials in URLs, `arguments`, or `_meta`.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "system_register",
    "arguments": {},
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

For ordinary requests, callers may omit `io.modelcontextprotocol/clientCapabilities`; the WebCross
gateway defaults it to `{}` before protocol processing. Clients using resource subscriptions must
still declare the capabilities they actually support.

`Mcp-Method` must match the body's `method`. Set `Mcp-Name` to the tool name for tool calls or
the resource URI for resource reads. These headers describe each request; do not reuse
`Mcp-Name: system_register` for a different operation. Put protocol metadata under `params._meta`,
not under `arguments`. The minimal client capabilities above are empty; a client that subscribes
must advertise its actual subscription capabilities.

Call `tools/list` to discover current tools before registration, then call `system_register`.
For `tools/list`, use `Mcp-Method: tools/list`, omit `Mcp-Name`, and send `params._meta` without
`name` or `arguments`. Do not send `initialize`, `notifications/initialized`, or `Mcp-Session-Id`
for the modern protocol. The tool catalog stays the same before and after registration.

Confirm that the call succeeded and `result.structuredContent.data.registered` is `true`.
Save `agentId`, `eventCursor`, `catalogRevision`, `guideRevision`, and `eventCatalogRevision` from
`result.structuredContent.data`. Without authentication, include the returned `agentId` in subsequent
tool `arguments`. `contextId` is a compatibility alias; if both are supplied, they must match.
Save the modern `eventsResourceUri`. When a task needs event listening, use `subscriptions/listen`
with `notifications.resourceSubscriptions` and declare the client capabilities actually supported.
Read events with `abcp_read_events` from the saved cursor;
advance it only after successful processing.

### Legacy MCP

Complete initialize and notifications/initialized first. Save and reuse the returned
Mcp-Session-Id, and send MCP-Protocol-Version for the negotiated version on subsequent requests.
The modern example's _meta, Mcp-Method, and Mcp-Name are not required by this legacy flow.
Reuse the valid MCP session. Initially, only system_register is exposed.
After registration, refresh tools/list. If the directory-change notification
does not arrive, request tools/list directly.

When a task needs event listening, subscribe to abcp://events after registration.
Resource updates indicate that newer events may
exist; consume them through abcp_read_events from the saved cursor.

### Read guidance

The abcp://docs/agent-skills resource returns the Browser Skill.
System.getCapabilities can return the Browser Skill or the connection
reference through the current system_get_capabilities tool.
Workflow.getGuide returns the workflow reference.

## WebSocket

When authentication is enabled, generate and copy an invitation from the User
panel's WS option. Automatic mode includes the same information under `ws`.
Read its `url` and `headers.Authorization` directly in the connecting client;
no CLI exchange is needed. The user and Agent are responsible for choosing a
trusted transfer channel. When the user explicitly authorizes the supplied
invitation and selected tool, pass the ticket through the input that channel
requires, including a tool argument when necessary. Never put it in the URL or
ordinary logs or output.

Complete the handshake within two minutes and use the ticket only once, then
call System.register. Expiry limits the handshake, not the duration of an
established connection. Copying again refreshes the ticket and invalidates the
previous unused ticket. After a failed connection or disconnect, copy a fresh
invitation from User. Identity revocation closes its connections and invalidates
unused tickets. Host restart invalidates these in-memory invitations.

With authentication disabled, use `endpoints.websocketUrl` without credentials.

Use canonical dot-separated Action methods from the current catalog.
Event transport methods are events.read, events.watch, and events.unwatch.

Pushed events arrive through System.notification. Use events.read to recover
gaps after reconnecting or whenever delivery is uncertain.

### WebSocket endpoint and registration

The endpoint has the form `ws://127.0.0.1:<actual-port>/ws`. Use the complete configured URL;
do not omit `/ws` or hardcode an example port. In authenticated automatic mode, read `ws.url`
and `ws.headers`; in WS mode, read `url` and `headers`. Without authentication, use
`endpoints.websocketUrl` and omit the Authorization header.

After the handshake succeeds, send this message before other Actions:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "System.register",
  "params": {}
}
```

Wait for a successful response with the same `id`, no JSON-RPC error, and
`result.data.registered === true`. Save `agentId`, `eventCursor`, `catalogRevision`,
`guideRevision`, and `eventCatalogRevision` from `result.data`. Then call
`System.getCapabilities` and `System.listEvents` using the same JSON-RPC envelope with a new request
ID and the corresponding method. Use exact Action names and parameters from the current catalog.
Events arrive through `System.notification`. After reconnecting and registering, use `events.read`
from the last successfully processed cursor to recover gaps.

## Commit and recover event cursors

1. Save the cursor of the last successfully processed event. A latest-visible
   cursor or resource update does not establish that events were processed.
2. Read from the saved cursor. Continue while hasMore is true, and persist
   nextCursor only after successfully processing that batch.
3. After reconnecting or restoring a listener, recover from the saved cursor.
   Live delivery and replay can overlap; use cursors to avoid processing an
   event's effects twice.
4. If the runtime rejects a saved cursor, retain it separately and follow the
   returned recovery instructions. Explicitly establish a new baseline from
   the current registration or session result and record the replay gap.

Events before a new runtime baseline may be unavailable. Report any resulting
uncertainty that affects the task.

## Recover a connection

Identify the failed layer: endpoint or runtime discovery, authentication,
registration, event delivery, or Action execution.

Follow the returned recovery instructions. Reuse the existing connection
configuration and valid identity for that environment. Register again when
required, restore event delivery, and refresh changed contracts.

Apply the Browser Skill's recovery rules before repeating browser operations.
Restoring a connection does not establish the outcome of an earlier request.

If the required environment remains unavailable, report the affected blocker
and the missing input or capability.

## Release a connection

Use system_disconnect only when intentionally releasing MCP connection state.

For modern MCP, it disconnects other modern calls and listeners using the same
identity. The credential remains valid. For legacy MCP, it terminates the
current session; stop using that session after acknowledgement.

Use the transport's normal close procedure when ending a WebSocket or CLI
connection. Close pages or Fleets only through separately authorized resource
lifecycle operations.
