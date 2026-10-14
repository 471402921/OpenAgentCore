# Parsar workspace

An independently started task workspace on OpenAgentCore, bringing Parsar’s task dispatch and run history into an optional public-API example. Organize projects and tasks, assign reusable Agents, continue execution conversations, inspect files, record delivery decisions, run recurring work and dispatch from Feishu groups. Agent execution uses bypass mode without approval gates. Core owns execution; Parsar owns product planning and channel delivery.

## Run

Use Node 22.13+ (for built-in SQLite) and pnpm 10.30.3. Configure [Core](../../docs/getting-started/install.md), a deployment model/provider, and a Project API key. Store secrets in a private environment file outside the checkout:

```sh
export OPENAI_BASE_URL='http://127.0.0.1:8091/v1'
export OPENAI_API_KEY='<project-api-key>'
pnpm --filter @oac/parsar-example... install --frozen-lockfile
pnpm --filter @oac/parsar-example dev
```

Open http://127.0.0.1:18180. `OPENAI_BASE_URL` ends in `/v1`; remote endpoints require HTTPS. An SSH tunnel can expose a remote Core on loopback without sending credentials over plaintext networks. `OAC_EXAMPLE_PORT` changes the local port. For a built version, run `pnpm --filter @oac/parsar-example build` and then `pnpm --filter @oac/parsar-example start`.

## Tasks and projects

**项目** stores shared context and an optional HTTPS repository URL. Context is included in each new task dispatch; a repository URL is an instruction, not automatic credential provisioning or checkout. **任务** offers board and list views, search by title/body/ID, and project/Agent filters. Tasks have a brief, priority, project, Agent and runtime. Tasks may be planned before those resources are configured.

**分配执行** creates a Session with a frozen task brief, project context and Agent configuration. **重新执行** creates another independent Session; use the original Session for follow-ups that need its history and workspace. Agent/runtime edits affect subsequent dispatches. An unresolved creation, a provisioning Session with no Turn, or an active Turn blocks another dispatch. **恢复执行** retries the original request and key after a lost response or server restart. Repeated concurrent dispatches cannot allocate two Sessions for one task revision.

The task detail shows durable comments, activity and run links. Comments are product records; they are not automatically sent to the Agent. Open a run to stream output, send a follow-up, cancel, connect a user machine, upload inputs or download Artifacts. Task navigation remains available from the Session. On a user-machine run, **填入任务说明，连接后发送** inserts the frozen brief into the composer for explicit sending once connected.

Business states (**待办**, **进行中**, **受阻**, **待验收**, **已完成**) remain distinct from Core’s execution states. Dispatch sets **进行中**; completion is recorded by the operator. Marking a task ready for review or done checks that its latest execution has settled. **待验收** is an optional progress state, not an execution permission or approval gate. Reopen a done task before dispatching again. Tasks with execution history cannot be deleted; referenced projects, Agents and runtimes cannot be deleted.

## Recurring work

**定时任务** uses an existing task as a template and an interval of 5–525600 minutes. Each occurrence freezes the current template and creates an independent task and Session. Execution must use a hosted or text-only runtime. The server must stay running; after downtime, missed intervals coalesce into one occurrence. A still-unsettled previous occurrence causes that interval to be skipped, preventing overlap.

Transient failures automatically retry the original occurrence without creating another task or Session. A definite rejection pauses the plan with its error and a task link; correct the configuration and enable the plan. A manually recovered task is reused when the plan resumes. Pending occurrences retain their original task/run IDs. Pausing stops future dispatches and does not cancel admitted work. Deleting a plan keeps created tasks and is blocked while an occurrence is unconfirmed.

## Feishu

**飞书** configures one enterprise self-built bot per installation, with up to 20 group routes. Each route selects a group ID, optional project, Agent and hosted/text-only runtime. Only explicit mentions of this bot in configured groups trigger work. Private messages, other bots and `@all` do not. Group membership is the authorization boundary: trusted members can run the selected Agent with its configured capabilities. Enable **允许群成员切换 Agent（共享机器人）** to let trusted members choose any Agent configured in this installation with `/list` and `/select <name or ID>`. The preference is per sender and group, applies to new tasks, and survives restarts; existing task threads keep their Session. The group’s configured runtime still applies, and unsupported combinations are rejected. With this switch off, the route’s Agent is fixed. User accounts and fine-grained permissions are not part of this example.

1. Create a self-built application in the [Feishu developer console](https://open.feishu.cn/app), enable its bot, and grant `im:message.group_at_msg:readonly` and `im:message:send_as_bot`.
2. Select long-connection event delivery and subscribe to `im.message.receive_v1`; publish the application and add the bot to your group.
3. Enter **App ID** and **App Secret**, add each allowed group and its execution configuration, enable **启用飞书机器人**, and save. Secrets stay in restricted server-side SQLite; blank secret edits preserve the saved value. No public callback route is needed.
4. Mention the bot with a text task. Parsar creates a task and Session and replies in the same thread. Reply in that thread with another mention to continue the same Session. Each new top-level message starts an independent task. Route changes affect new threads; existing threads keep their execution binding.
5. Use `/cancel`, `/review`, `/done` or `/reopen` in the same thread with a bot mention. Cancellation takes priority over queued follow-ups: earlier unconfirmed messages in that thread are withdrawn so they cannot restart work after cancellation. An uncertain Session creation is recovered before cancelling the actual Session. Cancellation acknowledgement is separate from confirmed stop. Execution has no approval workflow.

The official Feishu SDK owns authentication, normalization and WebSocket lifecycle. Its awaited event dispatcher saves accepted ingress in SQLite before acknowledging; a product worker submits the public Agents API request using a stable idempotency key. It reconciles durable Turns/Items after restarts and queues one final text reply per completed/failed/cancelled Turn. Summaries are bounded and include task IDs for Web search; complete history and file downloads remain available in the Web Session. Feishu media upload/download, streaming cards, personal bots, OAuth sign-in and other IM platforms are outside this example.

**最近投递** shows the latest 100 inbound/outbound receipts plus every unresolved receipt, with errors and **重试此投递**. Transient failures, including a busy Session, retry automatically with backoff capped at five minutes; definite rejections remain visible for correction. Failed ingress pauses subsequent messages in the same thread until the original receipt is retried. Feishu replies reuse a persisted UUID; uncertain outbound sends are never automatically replayed beyond 55 minutes because the vendor’s deduplication window is one hour. An expired uncertain receipt requires checking the original thread manually. Disabling the bot pauses ingestion and delivery without cancelling Core work. Removing a group or changing App ID never sends saved messages through another identity.

## Agent and Session configuration

1. **Models:** enter a Provider name, Base URL and API key, then fetch its `GET /v1/models` list. Select models with checkboxes or add custom model IDs, then save the Provider and selected models together. The dialog shows discovered and selected counts. For manual entry, skip discovery. No default group is created. Keys are stored in the local restricted SQLite file and never returned to the browser; leaving the key blank while editing preserves it. Discovery sends only that Provider's key and does not follow redirects. The list expects the OpenAI-shaped `data: [{id: "..."}]` response. Discovery failures leave manual entry available. Codex and Claude Code workspace Sessions pass the selected Provider URL/key explicitly to Core, using the harness protocol. These Sessions require an HTTPS Base URL and API key. Text-only Sessions and hosted MiniMax Code use Core's deployment connection; the creation dialog states that their Provider is only a catalog group. The example does not yet expose MiniMax Code's required token limits.
2. **Skills:** create a SKILL.md resource or upload a ZIP. Inspect versions, upload a new version, and choose the default. Core validates and stores bundles.
3. **MCP:** save anonymous HTTPS endpoints and bind them to Agents. Hosted Sessions install an inline environment Plugin; text-only Sessions use Core's service-origin MCP. Hosted HTTP MCP supports Claude Code and Codex, not MiniMax Code. Authentication, Vault management and OAuth setup are not included.
4. **Runtimes:** choose a Core-managed sandbox, text-only environment, or user machine. User machines select Linux/macOS/Windows and an existing absolute workspace path, plus an optional local capability directory. Each Session gets its own daemon installation and credential; choosing the same workspace path shares the host's files, so use distinct paths for isolated work. These are placement configurations, not online machine identities. Machine enrollment, fixed-node routing and self-hosted registration are omitted.
5. **Agents:** combine a model, harness, instructions, Skills and MCP services. Create, copy and edit configurations without allocating a runtime.
6. **Sessions:** open an Agent, choose a runtime and send the first message. Read streaming replies and tool activity, continue the conversation, cancel a running turn and reopen history. Unsupported Skill/MCP/runtime combinations are explained before creation. The Session's **Files** dialog uploads one file at a time (up to 5 MiB) through Core's public Environment Files API while idle. Each upload gets a unique path under `/workspace/inputs`; a path relative to the working directory is inserted into the message draft, not sent automatically. Unsent drafts, including uploaded file paths, survive reloads and navigation in the same browser tab and remain scoped to the Session. This keeps the API's `/workspace` alias distinct from the physical user-machine directory. Ask the Agent to save generated files under `./outputs`; published Artifacts can be paged and downloaded from the same dialog, even when the live workspace is unavailable. Downloads remain binary; errors stay in the dialog. Text-only Sessions have no file actions. Each hosted Session gets its own workspace; text-only has no workspace.

Agent edits and catalog updates apply to future Sessions. Core freezes existing Session configuration, including resolved Skill versions. Continuing a Session retains history and its workspace while the sandbox exists; archiving/replacing a sandbox is not a persistence guarantee. Saving configuration alone does not verify model availability or MCP connectivity. Skills require a hosted runtime.

## Ownership and storage

The loopback Node server exposes a fixed allowlist proxy for public Core resources and `/app/` operations for product-owned configuration, projects, tasks, comments, plans and channel receipts. One SQLite table stores typed JSON records. There is no ORM or product execution database. In-process workers handle interval plans and durable Feishu delivery; they call the same Session and task flows as the Web UI.

SQLite files live in `~/.oac/data/parsar-example/`. Set the absolute `OAC_EXAMPLE_DATA_DIR` to relocate them. A hash of the Core origin and Project key selects the file; changing either selects a different local catalog. Back up the SQLite file with the server stopped. The Core Project key is not stored in it. Provider keys and the Feishu App Secret are stored there. Builds and caches use `${OAC_DEV_HOME:-$HOME/.oac}`.

Use one server process and a dedicated Project for this local single-user example. The server rejects cross-origin writes and keeps the Project key out of browser responses. Session creation freezes a pending request in SQLite before calling Core, and uses the local Session ID as its idempotency key. An uncertain response can be recovered from the Agent's Session list, including after a server restart. Successful creation leaves only the Core Session reference and local title/Agent/runtime relationship; Core owns messages, turns and execution status. Task-linked Sessions additionally retain the frozen product brief and task reference. Feishu stores message delivery receipts and reply payloads for restart recovery, not a second authoritative execution history. The browser consumes public SSE text deltas through a non-buffering proxy, reconnects after interruption, and reconciles with durable history to avoid duplicate final replies. Each send records request-return latency and first nonempty text-delta latency from browser request start. These independent observations remain in sessionStorage across reloads; missing observations are shown as a dash rather than inferred from history. Definite validation rejection removes the pending request so it can be corrected. Deleting a local resource is blocked while another local record references it; Session deletion/archival is outside this example. Skill deletion is a separate explicit Core operation.

A few more implementation details:

- **Providers and models** are saved together in one SQLite transaction. Editing reads a Provider and its models as one snapshot; changing a model advances the Provider's revision.
- **Browser calls** use `OpenAIAgentsClient`, with a small public HTTP reader for Artifacts (not yet exposed by that client); only Session creation goes through a small server adapter. Closing the browser aborts the upstream stream, never the running Session.
- **Workspaces:** hosted Sessions each get their own. User-machine Sessions use the selected host directory, so the same path means shared files.
- **Skills on a user machine** come only from local capability directories in this example; it rejects Agents bound to managed Skills instead of ignoring them. Core itself can deliver managed Skills to user machines through `x_agents_core.environment`.

## Validation

```sh
make check-example
make check
```

The example gate runs TypeScript, proxy and SQLite persistence/binding tests, a production build and browser acceptance. Install Chrome with `pnpm --filter @oac/parsar-example exec playwright install chrome` if necessary. Browser fixtures use ports 18180/18181 and isolated SQLite data under `~/.oac/tests/parsar-example/`. They verify Provider groups and model selection, live text before durable completion, resource management, multiple Sessions, continuation, cancellation, lost-response recovery, Skill versions, projects/tasks, plans, Feishu configuration and mobile/help behavior. Durable worker tests cover duplicate delivery, frozen requests, safe retry windows and non-overlapping scheduled occurrences. Synthetic fixtures are not model execution.

The opt-in live browser probe requires an already started example backed by an isolated real Project:

```sh
OAC_EXAMPLE_LIVE_URL=http://127.0.0.1:18180 \
OAC_EXAMPLE_LIVE_MODEL='<configured-model>' \
pnpm --filter @oac/parsar-example test:live
```

It leaves sample resources for inspection and executes the configured model. It checks Skill/Plugin installation, same-Session file reuse, and workspace isolation between two Sessions. It asks the model to call DeepWiki; inspect the recorded tool activity to distinguish a successful call from an attempted call.

## Connect a user machine

Create a user-machine runtime and start a Session with an Agent using Codex or Claude Code. No initial Turn is sent. Open **Connect user machine** and run the Core-provided command on the target host. The installer downloads the matching native distribution, installs the selected harness and starts the connection. Windows Claude Code also requires Git Bash. The page reads Core's public Environment status and enables sending after it reports connected. The example backend does not need or accept the administrator Core key. Commands carry temporary Environment-scoped authorization; do not share them. Session refresh renews them.

The selected model Provider needs an HTTPS Base URL and API key. Its protocol is Responses for Codex and Anthropic for Claude Code. Core freezes and delivers the configuration to the enrolled executor. Local pending creation requests contain that configuration but browser Session responses omit the entire pending request.

Self-hosted capability sources are local directories under the current Core API. Managed Skill bindings fail explicitly; configure local Skills/Plugins in the runtime's capability directory before connecting. Bound HTTP MCP services also fail explicitly for self-hosted Sessions; configure them in local Plugins instead. MiniMax Code self-hosted configuration is not included in this example because its required token limits are not exposed.

The daemon runs with the starting user's permissions and adds no sandbox. Runtime home is separate per Session; stopping it preserves local files. Credential rotation and revocation remain Core console operations. Reuse the original installation directory when reconnecting.
