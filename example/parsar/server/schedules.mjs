import { requireSessionSettled, requireAutomaticRuntime } from "./sessions.mjs";
import { randomUUID } from "node:crypto";
import { AppError, text, uuid, transientError } from "./store.mjs";

export function scheduleAPI(store) {
  return async (method, path, body) => {
    const match = path.match(/^\/app\/schedules(?:\/([a-f0-9-]{36}))?$/);
    if (!match || (match[1] && !uuid.test(match[1])))
      throw new AppError(404, "Not found.");
    const id = match[1],
      old = id && store.get("schedules", id);
    if (method === "GET") {
      if (id && !old) throw new AppError(404, "计划不存在。");
      const publicRow = ({ pending, ...row }) => ({
        ...row,
        pending: pending ? { task_id: pending.task_id } : undefined,
      });
      return id ? publicRow(old) : store.list("schedules").map(publicRow);
    }
    if (!id || !["PUT", "DELETE"].includes(method))
      throw new AppError(405, "Method not allowed.");
    if (old && body.revision !== old.revision)
      throw new AppError(409, "计划已更新，请重新加载。");
    if (method === "DELETE") {
      if (old?.pending && store.get("tasks", old.pending.task_id))
        throw new AppError(
          409,
          "计划仍有未确认的执行，请先处理任务中的执行记录。",
        );
      store.remove("schedules", id);
      return {};
    }
    const template = store.get(
      "tasks",
      text(body.task_id, "任务模板", 36, true),
    );
    if (!template) throw new AppError(400, "请选择用作模板的任务。");
    if (body.enabled) requireAutomaticRuntime(store, template.runtime_id);
    if (body.enabled && !template.agent_id)
      throw new AppError(400, "任务模板需要 Agent 和可自动启动的运行时。");
    if (
      typeof body.enabled !== "boolean" ||
      !Number.isInteger(body.interval_minutes) ||
      body.interval_minutes < 5 ||
      body.interval_minutes > 525600
    )
      throw new AppError(400, "间隔必须为 5 至 525600 分钟。");
    const value = {
      id,
      name: text(body.name, "计划名称", 80, true),
      task_id: template.id,
      enabled: body.enabled,
      interval_minutes: body.interval_minutes,
      revision: (old?.revision || 0) + 1,
      next_at:
        old?.pending && body.enabled
          ? Date.now()
          : old &&
              old.enabled === body.enabled &&
              old.interval_minutes === body.interval_minutes
            ? old.next_at
            : Date.now() + body.interval_minutes * 60000,
      pending: old?.pending,
      last_task_id: old?.last_task_id,
      last_error: old?.last_error,
    };
    store.put("schedules", value);
    return value;
  };
}

// Missed intervals are coalesced into one occurrence; pending work never overlaps.
export function scheduleWorker(store, product, core) {
  let timer,
    running,
    stopping = false;
  const tick = async (time = Date.now()) => {
    for (const schedule of store.list("schedules")) {
      if (!schedule.enabled || schedule.next_at > time) continue;
      let occurrence = schedule.pending;
      try {
        if (!occurrence) {
          const latest =
            schedule.last_task_id &&
            store
              .list("sessions")
              .find((row) => row.task_id === schedule.last_task_id);
          if (latest) {
            try {
              await requireSessionSettled(core, latest);
            } catch (error) {
              if (!(error instanceof AppError) || error.status !== 409)
                throw error;
              const current = store.get("schedules", schedule.id);
              if (current)
                store.put("schedules", {
                  ...current,
                  next_at: time + current.interval_minutes * 60000,
                  last_error: "上次执行尚未结束，已跳过本次间隔。",
                  revision: current.revision + 1,
                });
              continue;
            }
          }
          const current = store.get("schedules", schedule.id);
          if (
            !current ||
            !current.enabled ||
            current.revision !== schedule.revision
          )
            continue;
          const template = store.get("tasks", schedule.task_id);
          if (!template) throw new AppError(400, "任务模板不存在。");
          requireAutomaticRuntime(store, template.runtime_id);
          if (!store.get("agents", template.agent_id || ""))
            throw new AppError(
              400,
              "任务模板需要 Agent 和可自动启动的运行时，请编辑模板后重新启用。",
            );
          occurrence = {
            task_id: randomUUID(),
            run_id: randomUUID(),
            template: { ...template },
            created_at: time,
          };
          store.put("schedules", { ...schedule, pending: occurrence });
        }
        let task = store.get("tasks", occurrence.task_id);
        if (!task)
          task = await product("PUT", `/app/tasks/${occurrence.task_id}`, {
            ...occurrence.template,
            revision: undefined,
            status: "backlog",
          });
        // A definite rejection leaves no Session. If the operator recovered
        // this occurrence from its task, adopt that run instead of dispatching again.
        const recovered =
          store.get("sessions", occurrence.run_id) ||
          store.list("sessions").find((row) => row.task_id === task.id);
        if (!recovered) requireAutomaticRuntime(store, task.runtime_id);
        await product(
          "PUT",
          `/app/tasks/${task.id}/runs/${recovered?.id || occurrence.run_id}`,
          { revision: task.revision },
        );
        const current = store.get("schedules", schedule.id);
        if (current)
          store.put("schedules", {
            ...current,
            pending: undefined,
            last_task_id: task.id,
            last_error: undefined,
            next_at: time + current.interval_minutes * 60000,
            revision: current.revision + 1,
          });
      } catch (error) {
        const current = store.get("schedules", schedule.id);
        const transient = transientError(error);
        if (current)
          store.put("schedules", {
            ...current,
            enabled: transient ? current.enabled : false,
            next_at: transient ? time + 15000 : current.next_at,
            last_task_id: occurrence?.task_id || current.last_task_id,
            last_error: transient
              ? "连接或执行结果暂未确认，将自动恢复原请求；不会创建另一轮执行。"
              : error instanceof AppError
                ? error.message
                : "计划执行失败，请检查最近任务。",
            revision: current.revision + 1,
          });
      }
    }
  };
  const cycle = async () => {
    if (stopping) return;
    running = tick();
    try {
      await running;
    } catch {
      console.error(
        "Parsar schedule worker could not access local state; retrying.",
      );
    } finally {
      if (!stopping) timer = setTimeout(cycle, 15000);
    }
  };
  return {
    tick,
    start() {
      void cycle();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await running;
    },
  };
}
