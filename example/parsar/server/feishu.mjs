import { createHash, randomUUID } from "node:crypto";
import { AppError, text, uuid, transientError } from "./store.mjs";
import { requireAutomaticRuntime } from "./sessions.mjs";
import { taskStatuses } from "../shared/work-profile.mjs";
import { sessionRestriction } from "../shared/session-profile.mjs";

const stamp = () => Date.now();
const selectionId = (app, chat, sender) => stableId(`${app}:${chat}:${sender}`);
const stableId = (value) => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
export const publicFeishu = ({ app_secret, ...record }) => ({
  ...record,
  has_app_secret: !!app_secret,
});
export function feishuAPI(store) {
  return async (method, path, body) => {
    const old = store.get("feishu", "settings") || {
      id: "settings",
      revision: 0,
      enabled: false,
      app_id: "",
      app_secret: "",
      routes: [],
    };
    const retryMatch = path.match(
      /^\/app\/feishu\/deliveries\/(inbound|outbound)\/([a-f0-9-]{36})$/,
    );
    if (retryMatch && method === "PUT" && uuid.test(retryMatch[2])) {
      const kind = `feishu_${retryMatch[1]}`,
        row = store.get(kind, retryMatch[2]);
      if (!row) throw new AppError(404, "投递记录不存在。");
      if (row.state !== "failed")
        throw new AppError(409, "此记录不需要手动重试。");
      if (
        kind === "feishu_outbound" &&
        row.first_attempt_at &&
        stamp() - row.first_attempt_at > 55 * 60000
      )
        throw new AppError(
          409,
          "飞书去重窗口已过。请人工检查原话题，不能安全自动重发。",
        );
      store.put(kind, {
        ...row,
        state: "queued",
        attempts: 0,
        error: undefined,
        next_at: 0,
      });
      return {};
    }
    if (path === "/app/feishu/status" && method === "GET")
      return store.get("feishu_health", "connection") || { state: "stopped" };
    if (path === "/app/feishu/deliveries" && method === "GET")
      return [
        ...store
          .list("feishu_inbound")
          .map((row) => ({ ...row, direction: "inbound" })),
        ...store
          .list("feishu_outbound")
          .map((row) => ({ ...row, direction: "outbound" })),
      ]
        .sort((a, b) => b.created_at - a.created_at)
        .filter(
          (row, index) =>
            index < 100 ||
            ["queued", "submitting", "failed"].includes(row.state),
        )
        .map(({ text, payload, event, ...row }) => {
          const taskId =
            row.task_id || store.get("feishu_threads", row.thread_id)?.task_id;
          return {
            ...row,
            task_id: taskId && store.get("tasks", taskId) ? taskId : undefined,
          };
        });
    if (path !== "/app/feishu") throw new AppError(404, "Not found.");
    if (method === "GET") return publicFeishu(old);
    if (method !== "PUT") throw new AppError(405, "Method not allowed.");
    if (old.revision !== body.revision)
      throw new AppError(409, "配置已更新，请重新加载。");
    const app_id = text(body.app_id, "App ID", 100).trim();
    const secret = body.app_secret
      ? text(body.app_secret, "App Secret", 300, true).trim()
      : old.app_secret;
    if (app_id !== old.app_id && !body.app_secret)
      throw new AppError(400, "更换 App ID 时请同时填写 App Secret。");
    if (
      typeof body.enabled !== "boolean" ||
      !Array.isArray(body.routes) ||
      body.routes.length > 20
    )
      throw new AppError(400, "飞书配置无效；最多配置 20 个群。");
    const routes = body.routes.map((route) => {
      const chat_id = text(route.chat_id, "群 ID", 100, true).trim();
      if (!/^oc_[a-zA-Z0-9_-]+$/.test(chat_id))
        throw new AppError(400, "群 ID 应以 oc_ 开头。");
      const agent = store.get(
          "agents",
          text(route.agent_id, "Agent", 36, true),
        ),
        runtime = store.get(
          "runtimes",
          text(route.runtime_id, "运行时", 36, true),
        );
      if (!agent || !runtime)
        throw new AppError(400, "请选择群对应的 Agent 和运行时。");
      if (body.enabled) {
        requireAutomaticRuntime(store, runtime.id);
        const restriction = sessionRestriction(agent, runtime);
        if (restriction) throw new AppError(400, restriction);
      }
      if (route.project_id && !store.get("projects", route.project_id))
        throw new AppError(400, "项目不存在。");
      return {
        chat_id,
        agent_id: agent.id,
        runtime_id: runtime.id,
        project_id: route.project_id || "",
        allow_agent_selection: route.allow_agent_selection === true,
      };
    });
    if (new Set(routes.map((r) => r.chat_id)).size !== routes.length)
      throw new AppError(400, "每个群只能有一条分配规则。");
    if (
      body.enabled &&
      (!/^cli_[0-9a-fA-F]{16}$/.test(app_id) || !secret || !routes.length)
    )
      throw new AppError(
        400,
        "启用前请配置 App ID、App Secret 和至少一个允许的群。",
      );
    const value = {
      id: "settings",
      app_id,
      app_secret: secret,
      enabled: body.enabled,
      routes,
      revision: old.revision + 1,
    };
    store.put("feishu", value);
    return publicFeishu(value);
  };
}

// The maintained SDK owns authentication, mention parsing and WebSocket lifecycle.
// SQLite owns delivery receipts across reconnects and process restarts.
export function feishuWorker(store, core, product, makeChannel) {
  let channel,
    active,
    timer,
    stopping = false,
    running;
  const health = (state) =>
    store.put("feishu_health", {
      id: "connection",
      state,
      updated_at: stamp(),
    });
  const allowed = (appId, chatId) => {
    const config = store.get("feishu", "settings");
    return (
      config?.enabled &&
      config.app_id === appId &&
      config.routes.some((r) => r.chat_id === chatId)
    );
  };
  const threadFor = (appId, message) =>
    store
      .list("feishu_threads")
      .find(
        (row) =>
          row.app_id === appId &&
          row.chat_id === message.chatId &&
          (row.root_id ===
            (message.rootId || message.replyToMessageId || message.messageId) ||
            (message.threadId && row.thread_id === message.threadId) ||
            store
              .list("feishu_outbound")
              .some(
                (out) =>
                  out.thread_id === row.id &&
                  out.sent_message_id === message.replyToMessageId,
              )),
      );
  const receive = (appId, message) => {
    if (
      !allowed(appId, message.chatId) ||
      message.chatType !== "group" ||
      !message.mentionedBot ||
      !message.senderId ||
      message.mentionAll
    )
      return;
    if (!message.content?.trim() || message.content.length > 40000) return;
    const id = stableId(`${appId}:${message.messageId}`);
    if (store.get("feishu_inbound", id)) return;
    const route = store
      .get("feishu", "settings")
      .routes.find((r) => r.chat_id === message.chatId);
    let thread = threadFor(appId, message);
    if (
      thread &&
      !store.get("tasks", thread.task_id) &&
      !message.content.trim().startsWith("/") &&
      ["rejected", "delivered"].includes(
        store.get("feishu_inbound", thread.first_message_id)?.state,
      )
    ) {
      thread = { ...thread, first_message_id: id };
    }
    const root =
      message.rootId || message.replyToMessageId || message.messageId;
    const threadId =
      thread?.id || stableId(`${appId}:${message.chatId}:${root}`);
    store.transaction(() => {
      if (thread?.first_message_id === id) store.put("feishu_threads", thread);
      if (!thread)
        store.put("feishu_threads", {
          id: threadId,
          app_id: appId,
          chat_id: message.chatId,
          root_id: root,
          thread_id: message.threadId,
          task_id: randomUUID(),
          session_id: randomUUID(),
          agent_id: route.agent_id,
          shared: route.allow_agent_selection,
          runtime_id: route.runtime_id,
          project_id: route.project_id,
          first_message_id: id,
          created_at: stamp(),
        });
      store.put("feishu_inbound", {
        id,
        app_id: appId,
        chat_id: message.chatId,
        thread_id: threadId,
        message_id: message.messageId,
        sender_id: message.senderId,
        text: message.content.trim(),
        state: "queued",
        attempts: 0,
        created_at: stamp(),
        next_at: 0,
      });
    });
  };
  const queueReply = (id, thread, payload) => {
    if (!store.get("feishu_outbound", id))
      store.put("feishu_outbound", {
        id,
        app_id: thread.app_id,
        chat_id: thread.chat_id,
        thread_id: thread.id,
        task_id: thread.task_id,
        reply_to: thread.root_id,
        payload,
        state: "queued",
        attempts: 0,
        created_at: stamp(),
        next_at: 0,
      });
  };
  const reject = (row, reason) => {
    store.put("feishu_inbound", { ...row, state: "rejected", error: reason });
    const thread = store.get("feishu_threads", row.thread_id);
    if (thread) queueReply(stableId(`${row.id}:rejected`), thread, reason);
  };
  const cancel = async (row) => {
    let thread = store.get("feishu_threads", row.thread_id);
    if (!thread) return reject(row, "话题关联不可用，请在 Web 中检查。");
    let run =
      store.get("sessions", thread.session_id) ||
      store.list("sessions").find((value) => value.task_id === thread.task_id);
    // Resolve an uncertain initial creation before cancelling its actual Session.
    if (run && !run.core_session_id)
      run = await product(
        "PUT",
        `/app/tasks/${thread.task_id}/runs/${run.id}`,
        {},
      );
    if (run && run.id !== thread.session_id) {
      thread = { ...thread, session_id: run.id };
      store.put("feishu_threads", thread);
    }
    store.transaction(() => {
      for (const previous of store.list("feishu_inbound").reverse()) {
        if (previous.id === row.id) break;
        if (
          previous.thread_id === row.thread_id &&
          !["delivered", "rejected"].includes(previous.state)
        )
          store.put("feishu_inbound", {
            ...previous,
            state: "rejected",
            error: "已被后续取消请求撤回，不会重新提交。",
          });
      }
      if (!run) {
        queueReply(
          stableId(`${row.id}:cancel`),
          thread,
          "已撤回此前等待处理的消息；此话题没有已启动的执行。",
        );
        store.put("feishu_inbound", {
          ...row,
          state: "delivered",
          error: undefined,
        });
      }
    });
    if (run) await inbound(row);
  };
  const inbound = async (row) => {
    let thread = store.get("feishu_threads", row.thread_id);
    if (!thread) return reject(row, "话题关联不可用，请在 Web 中检查。");
    const route = store
      .get("feishu", "settings")
      .routes.find((value) => value.chat_id === row.chat_id);
    if (row.text === "/list" || /^\/select(?:\s|$)/.test(row.text)) {
      if (!route?.allow_agent_selection)
        return reject(
          row,
          "此群使用固定 Agent；可在 Web 飞书配置中开启共享机器人切换。",
        );
      const agents = store.list("agents");
      let selection, reply;
      if (row.text === "/list") {
        reply =
          agents
            .map((agent) => `${agent.name} — ${agent.id}`)
            .join("\n")
            .slice(0, 5000) +
          "\n\n发送 /select <完整名称或 ID> 选择新任务的 Agent。选择仅影响你在此群发起的新任务；已有话题保持原会话。";
      } else {
        const target = row.text.slice(7).trim();
        const matches = agents.filter(
          (agent) => agent.id === target || agent.name === target,
        );
        if (matches.length !== 1)
          return reject(
            row,
            "请用 /list 查看 Agent，再用唯一名称或完整 ID 选择。",
          );
        const agent = matches[0],
          runtime = store.get("runtimes", route.runtime_id);
        const restriction = sessionRestriction(agent, runtime);
        if (restriction) return reject(row, restriction);
        selection = {
          id: selectionId(row.app_id, row.chat_id, row.sender_id),
          agent_id: agent.id,
        };
        reply = `已选择 ${agent.name}。你在此群发起的新任务将使用这个 Agent；已有话题保持原会话。`;
      }
      store.transaction(() => {
        if (selection) store.put("feishu_selections", selection);
        queueReply(stableId(`${row.id}:selection`), thread, reply);
        store.put("feishu_inbound", {
          ...row,
          state: "delivered",
          error: undefined,
        });
      });
      return;
    }
    const first = thread.first_message_id === row.id;
    let task = store.get("tasks", thread.task_id);
    if (!task) {
      if (!first)
        return reject(row, "话题任务不可用，请重新开一个话题描述任务。");
      if (row.text.startsWith("/"))
        return reject(row, "请先 @机器人 描述任务，再在同一话题中发送命令。");
      if (thread.shared && route?.allow_agent_selection) {
        const selected = store.get(
          "feishu_selections",
          selectionId(row.app_id, row.chat_id, row.sender_id),
        );
        if (selected) {
          thread = { ...thread, agent_id: selected.agent_id };
          store.put("feishu_threads", thread);
        }
      }
      task = await product("PUT", `/app/tasks/${thread.task_id}`, {
        name: row.text.split("\n")[0].slice(0, 80),
        description: row.text,
        project_id: thread.project_id,
        agent_id: thread.agent_id,
        runtime_id: thread.runtime_id,
        status: "backlog",
        priority: "normal",
      });
    }
    if (first) {
      // A manually recovered task may already have the occurrence's Session.
      if (!store.get("sessions", thread.session_id)) {
        const recovered = store
          .list("sessions")
          .find((run) => run.task_id === task.id);
        if (recovered) {
          thread = { ...thread, session_id: recovered.id };
          store.put("feishu_threads", thread);
        }
      }
      if (!store.get("sessions", thread.session_id))
        requireAutomaticRuntime(store, task.runtime_id);
      await product("PUT", `/app/tasks/${task.id}/runs/${thread.session_id}`, {
        revision: task.revision,
      });
      queueReply(
        stableId(`${row.id}:accepted`),
        thread,
        `已接收任务「${task.name}」。正在交给 Agent 执行。\n请在本话题中 @机器人 追问；/cancel 取消执行，/review 提交验收，/done 确认完成，/reopen 重新打开。\n任务编号：${task.id}（在 Parsar「任务」中搜索）`,
      );
    } else {
      const run = store.get("sessions", thread.session_id);
      if (!run?.core_session_id)
        return reject(row, "执行会话未确认，请先在 Web 中恢复原执行。");
      const commands = {
        "/review": "review",
        "/done": "done",
        "/reopen": "backlog",
      };
      if (commands[row.text]) {
        if (row.state !== "submitting") {
          try {
            await product("PUT", `/app/tasks/${task.id}`, {
              ...task,
              status: commands[row.text],
            });
          } catch (error) {
            if (error instanceof AppError && error.status === 409)
              return reject(row, error.message);
            throw error;
          }
          store.put("feishu_inbound", { ...row, state: "submitting" });
        }
        queueReply(
          stableId(`${row.id}:command`),
          thread,
          `任务状态已更新：${taskStatuses[commands[row.text]]}。`,
        );
      } else {
        if (!row.event && task.status === "done" && row.text !== "/cancel")
          return reject(row, "任务已完成，请先发送 /reopen 重新打开。");
        if (row.text.startsWith("/") && row.text !== "/cancel")
          return reject(
            row,
            "支持的命令：/list、/select、/cancel、/review、/done、/reopen。其他消息会交给 Agent。",
          );
        const event =
          row.event ||
          (row.text === "/cancel"
            ? { type: "agent.session.input.cancel" }
            : {
                type: "agent.session.input.message",
                input: [
                  {
                    role: "user",
                    content: [{ type: "input_text", text: row.text }],
                  },
                ],
              });
        store.put("feishu_inbound", { ...row, state: "submitting", event });
        await core(
          `/v1/agents/sessions/${run.core_session_id}/events`,
          "POST",
          { events: [event] },
          row.id,
        );
        if (row.text === "/cancel")
          queueReply(
            stableId(`${row.id}:cancel`),
            thread,
            "已请求取消，等待 Agent 确认停止。",
          );
      }
    }
    store.transaction(() => {
      store.put("feishu_inbound", {
        ...row,
        state: "delivered",
        error: undefined,
      });
      if (!store.get("activity", row.id))
        store.put("activity", {
          id: row.id,
          task_id: task.id,
          type: "feishu",
          message: row.text,
          actor: row.sender_id,
          created_at: Math.floor(row.created_at / 1000),
        });
    });
  };
  const history = async (sessionId, resource, after) => {
    const rows = [];
    for (let n = 0; n < 100; n++) {
      const page = await core(
        `/v1/agents/sessions/${sessionId}/${resource}?order=asc&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
        "GET",
      );
      rows.push(...page.data);
      if (!page.has_more) return rows;
      if (!page.last_id || page.last_id === after)
        throw new Error("Invalid history cursor");
      after = page.last_id;
    }
    throw new Error("History limit exceeded");
  };
  const observe = async (thread) => {
    const run = store.get("sessions", thread.session_id);
    if (!run?.core_session_id) return;
    const sid = run.core_session_id;
    const [session, turns] = await Promise.all([
      core(`/v1/agents/sessions/${sid}`, "GET"),
      history(sid, "turns", thread.turn_cursor),
    ]);
    const unseen = turns.filter(
      (turn) =>
        ["completed", "failed", "cancelled"].includes(turn.status) &&
        !store.get("feishu_outbound", stableId(`${thread.id}:${turn.id}`)),
    );
    if (session.status === "failed" && !turns.length && !thread.turn_cursor)
      queueReply(
        stableId(`${thread.id}:initial-failed`),
        thread,
        "执行环境准备失败或初始输入超时，请在 Web 任务中检查并重新执行。",
      );
    if (!unseen.length) return;
    const [items, artifacts] = await Promise.all([
      history(sid, "items", thread.item_cursor),
      history(sid, "artifacts", thread.artifact_cursor),
    ]);
    for (const turn of unseen) {
      const output = items
        .filter(
          (item) =>
            item.turn_id === turn.id &&
            item.type === "message" &&
            item.role === "assistant",
        )
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text)
        .join("\n\n");
      const files = artifacts
        .filter((file) => file.turn_id === turn.id)
        .map((file) => file.name || file.path || file.id)
        .join("、");
      const summary =
        turn.status === "completed"
          ? "Agent 执行结束，请验收结果。"
          : turn.status === "cancelled"
            ? "Agent 已停止执行。"
            : "Agent 执行失败，请在 Web 会话中检查。";
      queueReply(
        stableId(`${thread.id}:${turn.id}`),
        thread,
        `${summary}\n\n${output.slice(0, 5000)}${output.length > 5000 ? "\n…完整结果请在 Web 查看。" : ""}${files ? `\n\n产物：${files}（在 Web 会话下载）` : ""}\n\n任务编号：${thread.task_id}（在 Parsar「任务」中搜索）`,
      );
    }
    // Advance only through terminal Turns. Keep output for an active Turn available.
    const terminal = turns.findIndex(
      (turn) => !["completed", "failed", "cancelled"].includes(turn.status),
    );
    const completed = terminal < 0 ? turns : turns.slice(0, terminal);
    const ids = new Set(completed.map((turn) => turn.id));
    const cursor = (rows, previous) => {
      let value = previous;
      for (const row of rows) {
        if (!ids.has(row.turn_id)) break;
        value = row.id;
      }
      return value;
    };
    if (completed.length)
      store.put("feishu_threads", {
        ...thread,
        turn_cursor: completed.at(-1).id,
        item_cursor: cursor(items, thread.item_cursor),
        artifact_cursor: cursor(artifacts, thread.artifact_cursor),
      });
  };
  const retry = (kind, row, error) => {
    const attempts = row.attempts + 1;
    const definite = !transientError(error);
    store.put(kind, {
      ...store.get(kind, row.id),
      attempts,
      state: definite ? "failed" : store.get(kind, row.id).state,
      error: definite
        ? error.message
        : "连接或请求未确认，将按原标识重试；失败记录保留以供检查。",
      next_at: stamp() + Math.min(300000, 1000 * 2 ** attempts),
    });
    if (kind === "feishu_inbound" && definite) {
      const thread = store.get("feishu_threads", row.thread_id);
      if (thread)
        queueReply(
          stableId(`${row.id}:failed`),
          thread,
          "这条消息尚未成功处理。请在 Parsar 的飞书页面检查投递记录，并用原标识重试；不要重复创建任务。",
        );
    }
  };
  const deliver = async (current) => {
    for (const row of store.list("feishu_outbound").reverse()) {
      if (!current()) return;
      if (
        !allowed(row.app_id, row.chat_id) ||
        row.state !== "queued" ||
        row.next_at > stamp()
      )
        continue;
      // Feishu deduplicates UUIDs for one hour. Never automatically replay an uncertain send beyond that window.
      if (row.first_attempt_at && stamp() - row.first_attempt_at > 55 * 60000) {
        store.put("feishu_outbound", {
          ...row,
          state: "failed",
          error: "回传结果未确认且幂等窗口已过，请人工检查飞书话题。",
        });
        continue;
      }
      store.put("feishu_outbound", {
        ...row,
        first_attempt_at: row.first_attempt_at || stamp(),
      });
      try {
        const result = await channel.rawClient.im.message.reply({
          path: { message_id: row.reply_to },
          data: {
            msg_type: "text",
            content: JSON.stringify({ text: row.payload }),
            reply_in_thread: true,
            uuid: row.id,
          },
        });
        if (result.code !== 0 || !result.data?.message_id)
          throw new Error("Feishu rejected reply");
        store.put("feishu_outbound", {
          ...store.get("feishu_outbound", row.id),
          state: "delivered",
          sent_message_id: result.data.message_id,
          error: undefined,
        });
      } catch (error) {
        retry("feishu_outbound", row, error);
      }
    }
  };
  const tick = async () => {
    const config = store.get("feishu", "settings");
    if (!config?.enabled) {
      if (channel) await channel.disconnect();
      channel = undefined;
      active = undefined;
      health("stopped");
      return;
    }
    if (
      !active ||
      active.app_id !== config.app_id ||
      active.app_secret !== config.app_secret ||
      channel.getConnectionStatus?.()?.state === "failed"
    ) {
      if (channel) await channel.disconnect();
      channel = undefined;
      active = undefined;
      health("connecting");
      const next = await makeChannel(config, (message) =>
        receive(config.app_id, message),
      );
      channel = next;
      try {
        await channel.connect();
        active = config;
      } catch {
        await channel.disconnect();
        channel = undefined;
        health("error");
        return;
      }
    }
    active = config;
    const current = () =>
      store.get("feishu", "settings")?.revision === active.revision;
    if (!current()) return;
    health(channel.getConnectionStatus?.()?.state || "connected");
    await deliver(current);
    const rows = store.list("feishu_inbound").reverse();
    const cancellations = new Map();
    for (const row of rows)
      if (
        row.text === "/cancel" &&
        ["queued", "submitting"].includes(row.state)
      )
        cancellations.set(row.thread_id, row);
    const blocked = new Set(
      rows.filter((row) => row.state === "failed").map((row) => row.thread_id),
    );
    for (const row of cancellations.values()) {
      if (!current()) return;
      if (!allowed(row.app_id, row.chat_id)) continue;
      if (row.next_at <= stamp()) {
        try {
          await cancel(row);
        } catch (error) {
          retry("feishu_inbound", row, error);
        }
      }
      if (store.get("feishu_inbound", row.id).state === "delivered")
        blocked.delete(row.thread_id);
      else blocked.add(row.thread_id);
    }
    for (const original of rows) {
      if (!current()) return;
      const row = store.get("feishu_inbound", original.id);
      if (
        !allowed(row.app_id, row.chat_id) ||
        row.text === "/cancel" ||
        ["delivered", "failed", "rejected"].includes(row.state) ||
        blocked.has(row.thread_id)
      )
        continue;
      if (row.next_at <= stamp()) {
        try {
          await inbound(row);
        } catch (error) {
          retry("feishu_inbound", row, error);
        }
      }
      if (
        !["delivered", "rejected"].includes(
          store.get("feishu_inbound", row.id).state,
        )
      )
        blocked.add(row.thread_id);
    }
    for (const thread of store.list("feishu_threads")) {
      if (!current()) return;
      if (!allowed(thread.app_id, thread.chat_id)) continue;
      try {
        await observe(thread);
      } catch (error) {
        health("core_unavailable");
        if (
          !(error instanceof AppError) ||
          error.status >= 500 ||
          error.status === 429
        )
          break;
      }
    }
    await deliver(current);
  };
  const cycle = async () => {
    if (stopping) return;
    running = tick().catch(() => health("error"));
    await running;
    if (!stopping) timer = setTimeout(cycle, 5000);
  };
  return {
    receive,
    tick,
    start() {
      void cycle();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await running;
      await channel?.disconnect();
    },
  };
}

export async function createFeishuTransport(settings, receive) {
  const { Client, WSClient, EventDispatcher, normalize } = await import(
    "@larksuiteoapi/node-sdk"
  );
  // SDK diagnostics may contain authenticated WebSocket URLs and message bodies.
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const options = {
    appId: settings.app_id,
    appSecret: settings.app_secret,
    logger,
  };
  const client = new Client(options);
  const ws = new WSClient({ ...options, handshakeTimeoutMs: 15000 });
  return {
    rawClient: client,
    async connect() {
      const result = await client.request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      });
      const bot = result.bot || result.data?.bot;
      if (result.code !== 0 || !bot?.open_id)
        throw new Error("Cannot resolve Feishu bot identity");
      const dispatcher = new EventDispatcher({ logger }).register({
        "im.message.receive_v1": async (event) => {
          if (
            event.sender?.sender_type !== "user" ||
            event.message?.message_type !== "text"
          )
            return;
          const message = await normalize(event, {
            botIdentity: {
              openId: bot.open_id,
              name: bot.app_name || "Parsar",
            },
            stripBotMentions: true,
          });
          // Unlike the SDK's convenience Channel queue, the dispatcher awaits
          // this commit before acknowledging. Storage failure returns a retryable ACK.
          receive(message);
        },
      });
      await ws.start({ eventDispatcher: dispatcher });
    },
    async disconnect() {
      ws.close({ force: true });
    },
    getConnectionStatus() {
      return ws.getConnectionStatus();
    },
  };
}
