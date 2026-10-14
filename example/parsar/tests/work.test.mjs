import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openStore, AppError } from "../server/store.mjs";
import { productAPI } from "../server/product.mjs";
import { feishuWorker } from "../server/feishu.mjs";
import { scheduleWorker } from "../server/schedules.mjs";

async function setup(t) {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const calls = [],
    receipts = new Map(),
    resources = new Map();
  let lose = false,
    reject = false;
  const core = async (path, method, body, key) => {
    calls.push({ path, method, body, key });
    if (method === "POST") {
      if (reject) throw new AppError(422, "invalid");
      if (!receipts.has(key)) {
        if (path.endsWith("/events")) receipts.set(key, undefined);
        else {
          const id = randomUUID();
          receipts.set(key, { id });
          resources.set(id, {
            status: "idle",
            turns: [{ id: randomUUID(), status: "completed" }],
            items: [],
          });
        }
      }
      if (lose) {
        lose = false;
        throw new Error("lost response");
      }
      return receipts.get(key);
    }
    const id = path.split("/")[4],
      resource = resources.get(id);
    if (!resource) throw new AppError(404, "missing");
    if (path.includes("/turns"))
      return { data: resource.turns, has_more: false };
    if (path.includes("/items"))
      return { data: resource.items, has_more: false };
    if (path.includes("/artifacts")) return { data: [], has_more: false };
    return { id, status: resource.status };
  };
  const api = productAPI(store, core);
  const put = (kind, body, id = randomUUID()) =>
    api("PUT", `/app/${kind}/${id}`, body);
  const provider = await put("providers", { name: "Provider" });
  const model = await put("models", {
    name: "Model",
    provider_id: provider.id,
    model: "test-model",
  });
  const agent = await put("agents", {
    name: "Engineer",
    model_id: model.id,
    harness: "codex",
    instructions: "Work carefully",
    skill_ids: [],
    mcp_ids: [],
  });
  const runtime = await put("runtimes", { name: "Text", environment: "none" });
  const project = await put("projects", {
    name: "Website",
    description: "Accessible UI",
    repository: "https://github.com/example/site",
  });
  const task = await put("tasks", {
    name: "Review login",
    description: "Check keyboard navigation",
    project_id: project.id,
    agent_id: agent.id,
    runtime_id: runtime.id,
    status: "backlog",
    priority: "high",
  });
  return {
    store,
    core,
    api,
    put,
    agent,
    runtime,
    project,
    task,
    calls,
    receipts,
    resources,
    setLose: () => (lose = true),
    setReject: (value) => (reject = value),
  };
}
test("task dispatch freezes public request, recovers lost response, and guards pending/running/provisioning", async (t) => {
  const f = await setup(t),
    runId = randomUUID();
  f.setLose();
  await assert.rejects(
    f.api("PUT", `/app/tasks/${f.task.id}/runs/${runId}`, {
      revision: f.task.revision,
    }),
    /lost/,
  );
  const pending = await f.api("GET", `/app/tasks/${f.task.id}/runs`);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request, undefined);
  assert.match(f.calls[0].body.input, /Accessible UI/);
  assert.equal(f.calls[0].body.agent.multi_agent.enabled, false);
  const task = f.store.get("tasks", f.task.id);
  await assert.rejects(
    f.api("PUT", `/app/tasks/${task.id}/runs/${randomUUID()}`, {
      revision: task.revision,
    }),
    /尚未确认/,
  );
  const restarted = productAPI(f.store, f.core);
  const run = await restarted("PUT", `/app/tasks/${task.id}/runs/${runId}`, {});
  assert.equal(f.receipts.size, 1);
  assert.equal(run.request, undefined);
  assert.deepEqual(f.calls[0].body, f.calls[1].body);
  const state = f.resources.get(run.core_session_id);
  state.turns = [];
  await assert.rejects(
    f.put("tasks", { ...task, status: "done" }, task.id),
    /准备/,
  );
  state.status = "in_progress";
  state.turns = [{ id: randomUUID(), status: "in_progress" }];
  await assert.rejects(
    f.api("PUT", `/app/tasks/${task.id}/runs/${randomUUID()}`, {
      revision: task.revision,
    }),
    /执行/,
  );
  state.status = "idle";
  state.turns[0].status = "completed";
  const done = await f.put("tasks", { ...task, status: "done" }, task.id);
  await assert.rejects(
    f.api("PUT", `/app/tasks/${task.id}/runs/${randomUUID()}`, {
      revision: done.revision,
    }),
    /重新打开/,
  );
  await assert.rejects(
    f.api("DELETE", `/app/tasks/${task.id}`, done),
    /已有执行记录/,
  );
});
test("projects, comments and schedules maintain references and optimistic revisions", async (t) => {
  const f = await setup(t),
    comment = randomUUID();
  const path = `/app/tasks/${f.task.id}/activity/${comment}`;
  await f.api("PUT", path, { message: "Please verify focus order" });
  await f.api("PUT", path, { message: "Please verify focus order" });
  assert.equal(
    (await f.api("GET", `/app/tasks/${f.task.id}/activity`)).filter(
      (x) => x.type === "comment",
    ).length,
    1,
  );
  await assert.rejects(f.api("PUT", path, { message: "different" }), /标识/);
  await f.put("tasks", { ...f.task, name: "Changed" }, f.task.id);
  await assert.rejects(
    f.put("tasks", { ...f.task, name: "Stale" }, f.task.id),
    /已更新/,
  );
  await assert.rejects(
    f.api("DELETE", `/app/projects/${f.project.id}`, f.project),
    /仍有任务/,
  );
  await assert.rejects(
    f.api("DELETE", `/app/agents/${f.agent.id}`),
    /仍被引用/,
  );
  await assert.rejects(
    f.put(
      "projects",
      { ...f.project, repository: "https://secret@github.com/x" },
      f.project.id,
    ),
    /无凭据/,
  );
});
test("concurrent dispatches cannot create two Sessions", async (t) => {
  const f = await setup(t);
  const results = await Promise.allSettled(
    [randomUUID(), randomUUID()].map((id) =>
      f.api("PUT", `/app/tasks/${f.task.id}/runs/${id}`, {
        revision: f.task.revision,
      }),
    ),
  );
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(f.receipts.size, 1);
});
test("definite dispatch rejection removes pending request and leaves a retryable task", async (t) => {
  const f = await setup(t);
  f.setReject(true);
  await assert.rejects(
    f.api("PUT", `/app/tasks/${f.task.id}/runs/${randomUUID()}`, {
      revision: f.task.revision,
    }),
    /invalid/,
  );
  assert.equal(f.store.list("sessions").length, 0);
  assert.ok(
    f.store.list("activity").some((x) => x.type === "dispatch_rejected"),
  );
  f.setReject(false);
  const task = f.store.get("tasks", f.task.id);
  await f.api("PUT", `/app/tasks/${task.id}/runs/${randomUUID()}`, {
    revision: task.revision,
  });
  assert.equal(f.receipts.size, 1);
});
async function feishu(t) {
  const f = await setup(t),
    sent = [];
  await f.api("PUT", "/app/feishu", {
    revision: 0,
    app_id: "cli_0123456789abcdef",
    app_secret: "never-return-me",
    enabled: true,
    routes: [
      {
        chat_id: "oc_test",
        agent_id: f.agent.id,
        runtime_id: f.runtime.id,
        project_id: f.project.id,
      },
    ],
  });
  const channel = {
    connect: async () => {},
    disconnect: async () => {},
    getConnectionStatus: () => ({ state: "connected" }),
    rawClient: {
      im: {
        message: {
          reply: async (payload) => {
            sent.push(payload);
            return {
              code: 0,
              data: { message_id: `om_reply_${payload.data.uuid}` },
            };
          },
        },
      },
    },
  };
  const create = () =>
    feishuWorker(f.store, f.core, f.api, async () => channel);
  const message = {
    messageId: "om_first",
    chatId: "oc_test",
    chatType: "group",
    senderId: "ou_user",
    mentionedBot: true,
    content: "Investigate the checkout flow",
  };
  return { ...f, sent, create, message, channel };
}
test("Feishu settings redact secrets, default-deny chat dispatch and persist ingress before processing", async (t) => {
  const f = await feishu(t),
    worker = f.create();
  assert.equal(
    JSON.stringify(await f.api("GET", "/app/feishu")).includes(
      "never-return-me",
    ),
    false,
  );
  for (const patch of [
    { chatId: "oc_other" },
    { mentionedBot: false },
    { chatType: "p2p" },
    { senderId: "" },
  ])
    worker.receive("cli_0123456789abcdef", { ...f.message, ...patch });
  assert.equal(f.store.list("feishu_inbound").length, 0);
  worker.receive("cli_0123456789abcdef", f.message);
  worker.receive("cli_0123456789abcdef", f.message);
  assert.equal(f.store.list("feishu_inbound").length, 1);
  assert.equal(f.calls.length, 0);
  const restarted = f.create();
  await restarted.tick();
  assert.equal(f.receipts.size, 1);
  assert.equal(f.store.list("feishu_inbound")[0].state, "delivered");
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every((x) => x.data.reply_in_thread));
  await restarted.tick();
  assert.equal(f.sent.length, 2);
  const thread = f.store.list("feishu_threads")[0];
  worker.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_next",
    rootId: "om_first",
    content: "Also check mobile",
  });
  await restarted.tick();
  assert.equal(f.store.list("feishu_threads").length, 1);
  assert.equal(f.store.list("sessions").length, 1);
  assert.equal(f.calls.filter((x) => x.path.endsWith("/events")).length, 1);
  assert.equal(
    f.calls.find((x) => x.path.endsWith("/events")).body.events[0].input[0]
      .content[0].text,
    "Also check mobile",
  );
  assert.ok(
    f.store
      .list("activity")
      .some((x) => x.task_id === thread.task_id && x.actor === "ou_user"),
  );
});
test("Feishu retries lost Core response with same identity and expires uncertain outbound safely", async (t) => {
  const f = await feishu(t),
    worker = f.create();
  worker.receive("cli_0123456789abcdef", f.message);
  f.setLose();
  await worker.tick();
  const inbound = f.store.list("feishu_inbound")[0];
  f.store.put("feishu_inbound", { ...inbound, next_at: 0 });
  const restarted = f.create();
  await restarted.tick();
  assert.equal(f.receipts.size, 1);
  const posts = f.calls.filter((x) => x.method === "POST");
  assert.equal(posts[0].key, posts[1].key);
  const out = f.store.list("feishu_outbound")[0];
  f.store.put("feishu_outbound", {
    ...out,
    state: "queued",
    first_attempt_at: Date.now() - 3600000,
    next_at: 0,
  });
  const count = f.sent.length;
  await restarted.tick();
  assert.equal(f.sent.length, count);
  assert.equal(f.store.get("feishu_outbound", out.id).state, "failed");
});
test("Feishu disabling pauses processing and changing app never reroutes queued receipts", async (t) => {
  const f = await feishu(t),
    worker = f.create();
  worker.receive("cli_0123456789abcdef", f.message);
  const config = await f.api("GET", "/app/feishu");
  await f.api("PUT", "/app/feishu", { ...config, enabled: false });
  await worker.tick();
  assert.equal(f.calls.length, 0);
  await f.api("PUT", "/app/feishu", {
    ...config,
    revision: config.revision + 1,
    app_id: "cli_fedcba9876543210",
    app_secret: "other",
    enabled: true,
  });
  await worker.tick();
  assert.equal(f.calls.length, 0);
});
test("scheduled occurrences survive lost responses and do not overlap active prior work", async (t) => {
  const f = await setup(t),
    id = randomUUID();
  let schedule = await f.api("PUT", `/app/schedules/${id}`, {
    name: "Daily review",
    task_id: f.task.id,
    interval_minutes: 5,
    enabled: true,
  });
  const worker = scheduleWorker(f.store, f.api, f.core);
  f.setLose();
  await worker.tick(schedule.next_at);
  schedule = f.store.get("schedules", id);
  assert.equal(schedule.enabled, true);
  assert.ok(schedule.pending);
  const occurrence = schedule.pending.task_id;
  await worker.tick(schedule.next_at + 1);
  assert.equal(f.receipts.size, 1);
  schedule = f.store.get("schedules", id);
  assert.equal(schedule.last_task_id, occurrence);
  const run = f.store.list("sessions")[0];
  f.resources.get(run.core_session_id).status = "in_progress";
  await worker.tick(schedule.next_at);
  assert.equal(f.receipts.size, 1);
  assert.match(f.store.get("schedules", id).last_error, /跳过/);
});

test("Feishu commands do not poison new topics and rejected controls do not block later messages", async (t) => {
  const f = await feishu(t),
    w = f.create();
  w.receive("cli_0123456789abcdef", { ...f.message, content: "/done" });
  await w.tick();
  assert.equal(f.store.list("feishu_inbound")[0].state, "rejected");
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_task",
    rootId: "om_first",
  });
  await w.tick();
  assert.equal(f.store.list("sessions").length, 1);
  const run = f.store.list("sessions")[0];
  f.resources.get(run.core_session_id).status = "in_progress";
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_done",
    rootId: "om_first",
    content: "/done",
  });
  await w.tick();
  assert.equal(f.store.list("feishu_inbound")[0].state, "rejected");
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_cancel",
    rootId: "om_first",
    content: "/cancel",
  });
  await w.tick();
  assert.ok(
    f.calls.some(
      (x) => x.body?.events?.[0].type === "agent.session.input.cancel",
    ),
  );
});
test("uncertain follow-up retains its event when task state changes, and history resumes at its cursor", async (t) => {
  const f = await feishu(t),
    w = f.create();
  w.receive("cli_0123456789abcdef", f.message);
  await w.tick();
  const thread = f.store.list("feishu_threads")[0],
    task = f.store.get("tasks", thread.task_id);
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_follow",
    rootId: "om_first",
    content: "Follow up",
  });
  f.setLose();
  await w.tick();
  const row = f.store.list("feishu_inbound")[0];
  f.store.put("tasks", { ...task, status: "done" });
  f.store.put("feishu_inbound", { ...row, next_at: 0 });
  await w.tick();
  const events = f.calls.filter((x) => x.path.endsWith("/events"));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], events[1]);
  assert.equal(f.store.get("feishu_inbound", row.id).state, "delivered");
  assert.ok(
    f.calls.some(
      (x) => x.path.includes("/turns?") && x.path.includes("after="),
    ),
  );
});
test("Feishu closes failed connections and never sends through a config changed during connect", async (t) => {
  const f = await feishu(t);
  let disconnects = 0,
    connections = 0,
    state = "failed";
  f.channel.disconnect = async () => {
    disconnects++;
  };
  f.channel.connect = async () => {
    connections++;
  };
  f.channel.getConnectionStatus = () => ({ state });
  const w = f.create();
  await w.tick();
  state = "connected";
  await w.tick();
  state = "failed";
  await w.tick();
  assert.equal(connections, 2);
  assert.equal(disconnects, 1);
  await w.stop();
  const changed = feishuWorker(f.store, f.core, f.api, async () => ({
    ...f.channel,
    connect: async () => {
      const config = await f.api("GET", "/app/feishu");
      await f.api("PUT", "/app/feishu", { ...config, enabled: false });
    },
  }));
  changed.receive("cli_0123456789abcdef", f.message);
  await changed.tick();
  assert.equal(f.receipts.size, 0);
  await changed.stop();
});
test("schedule read failures keep overlap identity, and invalid edited templates pause before freezing", async (t) => {
  const f = await setup(t),
    id = randomUUID();
  let plan = await f.api("PUT", `/app/schedules/${id}`, {
    name: "Plan",
    task_id: f.task.id,
    interval_minutes: 5,
    enabled: true,
  });
  await scheduleWorker(f.store, f.api, f.core).tick(plan.next_at);
  plan = f.store.get("schedules", id);
  await scheduleWorker(f.store, f.api, async () => {
    throw new Error("offline");
  }).tick(plan.next_at);
  const retry = f.store.get("schedules", id);
  assert.equal(retry.enabled, true);
  assert.equal(retry.last_task_id, plan.last_task_id);
  f.store.put("tasks", { ...f.task, agent_id: "" });
  await scheduleWorker(f.store, f.api, f.core).tick(retry.next_at);
  const invalid = f.store.get("schedules", id);
  assert.equal(invalid.enabled, false);
  assert.equal(invalid.pending, undefined);
  assert.equal(invalid.last_task_id, plan.last_task_id);
});
test("official Feishu dispatcher awaits persistence and propagates a failed commit", async (t) => {
  const { Client, WSClient } = await import("@larksuiteoapi/node-sdk");
  const { createFeishuTransport } = await import("../server/feishu.mjs");
  let dispatcher,
    received = 0,
    fail = false;
  t.mock.method(Client.prototype, "request", async () => ({
    code: 0,
    bot: { open_id: "ou_bot", app_name: "Parsar" },
  }));
  t.mock.method(WSClient.prototype, "start", async (options) => {
    dispatcher = options.eventDispatcher;
  });
  t.mock.method(WSClient.prototype, "close", () => {});
  const transport = await createFeishuTransport(
    { app_id: "cli_0123456789abcdef", app_secret: "test" },
    (message) => {
      assert.equal(message.content, "A task");
      assert.equal(message.mentionedBot, true);
      if (fail) throw new Error("commit failed");
      received++;
    },
  );
  await transport.connect();
  const event = {
    schema: "2.0",
    header: { event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_id: "om_test",
        chat_id: "oc_test",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 A task" }),
        mentions: [
          { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Parsar" },
        ],
      },
    },
  };
  await dispatcher.invoke(event, { needCheck: false });
  assert.equal(received, 1);
  fail = true;
  await assert.rejects(
    dispatcher.invoke(event, { needCheck: false }),
    /commit failed/,
  );
  assert.equal(received, 1);
  await transport.disconnect();
});

test("scheduled and Feishu retries adopt a manual recovery after a definite rejection", async (t) => {
  const f = await feishu(t),
    planId = randomUUID();
  let plan = await f.api("PUT", `/app/schedules/${planId}`, {
    name: "Plan",
    task_id: f.task.id,
    interval_minutes: 5,
    enabled: true,
  });
  const scheduler = scheduleWorker(f.store, f.api, f.core);
  f.setReject(true);
  await scheduler.tick(plan.next_at);
  plan = f.store.get("schedules", planId);
  const task = f.store.get("tasks", plan.pending.task_id);
  f.setReject(false);
  const manual = await f.api(
    "PUT",
    `/app/tasks/${task.id}/runs/${randomUUID()}`,
    { revision: task.revision },
  );
  await f.api("PUT", `/app/schedules/${planId}`, { ...plan, enabled: true });
  await scheduler.tick(plan.next_at);
  assert.equal(f.receipts.size, 1);
  assert.equal(f.store.list("sessions")[0].id, manual.id);
  const w = f.create();
  w.receive("cli_0123456789abcdef", f.message);
  f.setReject(true);
  await w.tick();
  const thread = f.store.list("feishu_threads")[0],
    incoming = f.store.list("feishu_inbound")[0];
  assert.equal(incoming.state, "failed");
  f.setReject(false);
  const feishuTask = f.store.get("tasks", thread.task_id),
    recovered = await f.api(
      "PUT",
      `/app/tasks/${thread.task_id}/runs/${randomUUID()}`,
      { revision: feishuTask.revision },
    );
  await f.api("PUT", `/app/feishu/deliveries/inbound/${incoming.id}`, {});
  await w.tick();
  assert.equal(f.receipts.size, 2);
  assert.equal(
    f.store.get("feishu_threads", thread.id).session_id,
    recovered.id,
  );
});

test("unresolved Feishu receipts remain discoverable after more than 100 newer deliveries", async (t) => {
  const f = await feishu(t),
    w = f.create();
  w.receive("cli_0123456789abcdef", f.message);
  f.setReject(true);
  await w.tick();
  const failed = f.store.list("feishu_inbound")[0];
  assert.equal(failed.state, "failed");
  for (let i = 0; i < 110; i++)
    f.store.put("feishu_outbound", {
      id: randomUUID(),
      state: "delivered",
      thread_id: failed.thread_id,
      created_at: failed.created_at + i + 1,
    });
  const visible = await f.api("GET", "/app/feishu/deliveries");
  assert.ok(visible.some((row) => row.id === failed.id));
  f.setReject(false);
  await f.api("PUT", `/app/feishu/deliveries/inbound/${failed.id}`, {});
  await w.tick();
  assert.equal(f.store.get("feishu_inbound", failed.id).state, "delivered");
});

test("busy Core input retries past eight attempts and queued replies precede Core reads", async (t) => {
  const f = await feishu(t),
    initial = f.create();
  initial.receive("cli_0123456789abcdef", f.message);
  await initial.tick();
  let busy = true;
  const order = [];
  const core = async (...args) => {
    order.push("core");
    if (busy && args[0].endsWith("/events"))
      throw new AppError(409, "Earlier input is pending");
    return f.core(...args);
  };
  const reply = f.channel.rawClient.im.message.reply;
  f.channel.rawClient.im.message.reply = async (payload) => {
    order.push("reply");
    return reply(payload);
  };
  const w = feishuWorker(f.store, core, f.api, async () => f.channel);
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_busy",
    rootId: "om_first",
    content: "More work",
  });
  const incoming = f.store.list("feishu_inbound")[0];
  f.store.put("feishu_inbound", { ...incoming, attempts: 9 });
  const out = f.store.list("feishu_outbound")[0];
  f.store.put("feishu_outbound", { ...out, state: "queued", next_at: 0 });
  await w.tick();
  assert.equal(order[0], "reply");
  const pending = f.store.get("feishu_inbound", incoming.id);
  assert.equal(pending.state, "submitting");
  assert.equal(pending.attempts, 10);
  busy = false;
  f.store.put("feishu_inbound", { ...pending, next_at: 0 });
  await w.tick();
  assert.equal(f.store.get("feishu_inbound", incoming.id).state, "delivered");
});
test("schedule HTTP 503 during the settle check retries without losing overlap protection", async (t) => {
  const f = await setup(t),
    id = randomUUID();
  let plan = await f.api("PUT", `/app/schedules/${id}`, {
    name: "Plan",
    task_id: f.task.id,
    interval_minutes: 5,
    enabled: true,
  });
  await scheduleWorker(f.store, f.api, f.core).tick(plan.next_at);
  plan = f.store.get("schedules", id);
  await scheduleWorker(f.store, f.api, async () => {
    throw new AppError(503, "Unavailable");
  }).tick(plan.next_at);
  const retry = f.store.get("schedules", id);
  assert.equal(retry.enabled, true);
  assert.equal(retry.last_task_id, plan.last_task_id);
  assert.equal(retry.next_at, plan.next_at + 15000);
  assert.equal(f.receipts.size, 1);
});

test("terminal public API conflicts preserve their code and stop automatic Feishu retry", async (t) => {
  const { coreClient } = await import("../server.mjs");
  const failed = coreClient(
    { target: "https://core.invalid", key: "test" },
    async () =>
      Response.json(
        {
          error: {
            code: "environment_unavailable",
            message: "Environment unavailable",
          },
        },
        { status: 409 },
      ),
  );
  await assert.rejects(
    failed("/v1/agents/sessions", "POST", {}),
    (error) => error.code === "environment_unavailable",
  );
  const f = await feishu(t),
    initial = f.create();
  initial.receive("cli_0123456789abcdef", f.message);
  await initial.tick();
  const w = feishuWorker(
    f.store,
    async (...args) =>
      args[0].endsWith("/events") ? failed(...args) : f.core(...args),
    f.api,
    async () => f.channel,
  );
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_gone",
    rootId: "om_first",
    content: "Follow up",
  });
  await w.tick();
  const receipt = f.store.list("feishu_inbound")[0];
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error, "Environment unavailable");
});

test("shared Feishu selection is durable, sender-scoped, and applies only to new task threads", async (t) => {
  const f = await feishu(t),
    config = await f.api("GET", "/app/feishu");
  const other = await f.put("agents", {
    ...f.agent,
    id: undefined,
    revision: undefined,
    name: "Designer",
  });
  await f.api("PUT", "/app/feishu", {
    ...config,
    routes: config.routes.map((route) => ({
      ...route,
      allow_agent_selection: true,
    })),
  });
  const w = f.create();
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_list",
    content: "/list",
  });
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_select",
    content: `/select ${other.id}`,
  });
  w.receive("cli_0123456789abcdef", { ...f.message, messageId: "om_work" });
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_colleague",
    senderId: "ou_colleague",
  });
  await w.tick();
  const mine = f.store
      .list("feishu_threads")
      .find((row) => row.root_id === "om_work"),
    colleague = f.store
      .list("feishu_threads")
      .find((row) => row.root_id === "om_colleague");
  assert.equal(f.store.get("tasks", mine.task_id).agent_id, other.id);
  assert.equal(f.store.get("tasks", colleague.task_id).agent_id, f.agent.id);
  const deliveries = await f.api("GET", "/app/feishu/deliveries");
  const command = f.store
    .list("feishu_inbound")
    .find((row) => row.message_id === "om_select");
  assert.equal(
    deliveries.find((row) => row.id === command.id).task_id,
    undefined,
  );
  const restarted = f.create();
  restarted.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_reset",
    rootId: "om_work",
    content: `/select ${f.agent.id}`,
  });
  await restarted.tick();
  restarted.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_followup",
    rootId: "om_work",
    content: "Continue this task",
  });
  await restarted.tick();
  assert.equal(f.store.get("feishu_threads", mine.id).agent_id, other.id);
  assert.equal(f.store.list("sessions").length, 2);
  const current = await f.api("GET", "/app/feishu");
  await f.api("PUT", "/app/feishu", {
    ...current,
    routes: current.routes.map((route) => ({
      ...route,
      allow_agent_selection: false,
    })),
  });
  restarted.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_denied",
    content: `/select ${other.id}`,
  });
  await restarted.tick();
  assert.equal(f.store.list("feishu_inbound")[0].state, "rejected");
});

test("automatic Feishu dispatch revalidates a runtime edited after bot setup", async (t) => {
  const f = await feishu(t),
    w = f.create();
  f.store.put("runtimes", { ...f.runtime, environment: "self_hosted" });
  w.receive("cli_0123456789abcdef", f.message);
  await w.tick();
  assert.equal(f.receipts.size, 0);
  const receipt = f.store.list("feishu_inbound")[0];
  assert.equal(receipt.state, "failed");
  assert.match(receipt.error, /自动执行/);
});

test("a new schedule ignores unrelated standalone Sessions when checking overlap", async (t) => {
  const f = await setup(t),
    id = randomUUID();
  f.store.put("sessions", {
    id: randomUUID(),
    agent_id: f.agent.id,
    runtime_id: f.runtime.id,
    core_session_id: "unrelated-standalone",
  });
  const plan = await f.api("PUT", `/app/schedules/${id}`, {
    name: "Plan",
    task_id: f.task.id,
    interval_minutes: 5,
    enabled: true,
  });
  await scheduleWorker(f.store, f.api, f.core).tick(plan.next_at);
  assert.equal(f.receipts.size, 1);
  assert.equal(
    f.calls.some((call) => call.path.includes("unrelated-standalone")),
    false,
  );
  assert.ok(f.store.get("schedules", id).last_task_id);
});

test("Feishu cancellation bypasses busy follow-ups and withdraws them permanently", async (t) => {
  const f = await feishu(t),
    initial = f.create();
  initial.receive("cli_0123456789abcdef", f.message);
  await initial.tick();
  const events = [];
  const core = async (...args) => {
    if (args[0].endsWith("/events")) {
      events.push(args[2].events[0].type);
      if (args[2].events[0].type === "agent.session.input.message")
        throw new AppError(409, "Earlier input pending");
    }
    return f.core(...args);
  };
  const w = feishuWorker(f.store, core, f.api, async () => f.channel);
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_wait",
    rootId: "om_first",
    content: "Follow up",
  });
  await w.tick();
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_stop",
    rootId: "om_first",
    content: "/cancel",
  });
  await w.tick();
  assert.deepEqual(events, [
    "agent.session.input.message",
    "agent.session.input.cancel",
  ]);
  assert.equal(
    f.store.list("feishu_inbound").find((row) => row.message_id === "om_wait")
      .state,
    "rejected",
  );
  await w.tick();
  assert.equal(events.length, 2);
});
test("Feishu can withdraw an unstarted task and recover a lost creation before cancelling", async (t) => {
  const f = await feishu(t),
    w = f.create();
  w.receive("cli_0123456789abcdef", f.message);
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_stop",
    rootId: "om_first",
    content: "/cancel",
  });
  await w.tick();
  assert.equal(f.receipts.size, 0);
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_new",
    content: "Start new task",
  });
  f.setLose();
  await w.tick();
  assert.equal(f.receipts.size, 1);
  w.receive("cli_0123456789abcdef", {
    ...f.message,
    messageId: "om_cancel_pending",
    rootId: "om_new",
    content: "/cancel",
  });
  await w.tick();
  assert.equal(f.store.list("sessions").length, 1);
  assert.ok(
    f.calls.some(
      (call) => call.body?.events?.[0].type === "agent.session.input.cancel",
    ),
  );
});

test("automation can be disabled after runtime eligibility changes but cannot resume", async (t) => {
  const f = await feishu(t), id = randomUUID();
  const plan = await f.api("PUT", `/app/schedules/${id}`, {
    name: "Plan", task_id: f.task.id, interval_minutes: 5, enabled: true,
  });
  f.store.put("runtimes", { ...f.runtime, environment: "self_hosted" });
  const paused = await f.api("PUT", `/app/schedules/${id}`, {
    ...plan, enabled: false,
  });
  assert.equal(paused.enabled, false);
  await assert.rejects(f.api("PUT", `/app/schedules/${id}`, {
    ...paused, enabled: true,
  }), { status: 400 });
  const config = await f.api("GET", "/app/feishu");
  const disabled = await f.api("PUT", "/app/feishu", {
    ...config, enabled: false,
  });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.routes, config.routes);
  await assert.rejects(f.api("PUT", "/app/feishu", {
    ...disabled, enabled: true,
  }), { status: 400 });
  assert.equal(f.store.get("feishu", "settings").enabled, false);
});
