import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Play,
  Pencil,
  MessageSquare,
  ExternalLink,
} from "lucide-react";
import {
  product,
  useAgents,
  useRuntimes,
  useProjects,
  taskStatuses,
  taskPriorities,
  type TaskRecord,
  type TaskActivity,
  type SessionRecord,
} from "./lib/product";
import { api, dateTime, sessionState } from "./lib/api";
import { sessionRestriction } from "../shared/session-profile.mjs";
import { TaskEditor, TaskStatus } from "./Tasks";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { Select, SelectOption } from "./components/ui/select";
import { ErrorNotice } from "./components/shared";
import { EmptyState } from "./components/ui/empty-state";

export function RunStatus({ run }: { run: SessionRecord }) {
  const query = useQuery({
    queryKey: ["run-status", run.core_session_id],
    enabled: !!run.core_session_id,
    queryFn: async ({ signal }) => {
      const [session, turns] = await Promise.all([
        api.retrieveSession(run.core_session_id!, { signal }),
        api.listTurns(run.core_session_id!, {
          limit: 1,
          order: "desc",
          signal,
        }),
      ]);
      return sessionState(session, turns.data[0]).label;
    },
    refetchInterval: 5000,
  });
  return (
    <span>
      {!run.core_session_id
        ? "待恢复"
        : query.error
          ? "状态暂不可用"
          : query.data || "读取状态…"}
    </span>
  );
}
export function TaskDetail({ id }: { id: string }) {
  const cache = useQueryClient();
  const task = useQuery({
    queryKey: ["task", id],
    queryFn: () => product<TaskRecord>(`tasks/${id}`),
    refetchInterval: 5000,
  });
  const runs = useQuery({
    queryKey: ["task-runs", id],
    queryFn: () => product<SessionRecord[]>(`tasks/${id}/runs`),
    refetchInterval: 5000,
  });
  const activity = useQuery({
    queryKey: ["task-activity", id],
    queryFn: () => product<TaskActivity[]>(`tasks/${id}/activity`),
    refetchInterval: 5000,
  });
  const agents = useAgents(),
    runtimes = useRuntimes(),
    projects = useProjects();
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [commentId, setCommentId] = useState(() => crypto.randomUUID());
  const [runId, setRunId] = useState(() => crypto.randomUUID());
  const refresh = () => {
    for (const key of [
      ["tasks"],
      ["task", id],
      ["task-runs", id],
      ["task-activity", id],
      ["sessions"],
    ])
      void cache.invalidateQueries({ queryKey: key });
  };
  const change = useMutation({
    mutationFn: (status: TaskRecord["status"]) =>
      product(`tasks/${id}`, "PUT", { ...task.data, status }),
    onSettled: refresh,
  });
  const dispatch = useMutation({
    mutationFn: () =>
      product<SessionRecord>(
        `tasks/${id}/runs/${runs.data?.find((row) => !row.core_session_id)?.id || runId}`,
        "PUT",
        { revision: task.data?.revision },
      ),
    onSettled: refresh,
    onSuccess: (run) => {
      setRunId(crypto.randomUUID());
      location.hash = `/sessions/${run.id}`;
    },
  });
  const post = useMutation({
    mutationFn: () =>
      product(`tasks/${id}/activity/${commentId}`, "PUT", { message: comment }),
    onSuccess: () => {
      setComment("");
      setCommentId(crypto.randomUUID());
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => product(`tasks/${id}`, "DELETE", task.data),
    onSuccess: () => {
      refresh();
      location.hash = "/tasks";
    },
  });
  const row = task.data;
  const agent = agents.data?.find((a) => a.id === row?.agent_id),
    runtime = runtimes.data?.find((r) => r.id === row?.runtime_id),
    project = projects.data?.find((p) => p.id === row?.project_id);
  const restriction = agent ? sessionRestriction(agent, runtime) : undefined;
  const pending = runs.data?.find((run) => !run.core_session_id);
  if (!row)
    return (
      <>
        <ErrorNotice error={task.error} retry={() => void task.refetch()} />
        <EmptyState title={task.isPending ? "正在加载…" : "任务不可用"} />
      </>
    );
  return (
    <>
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-line px-6 py-3">
        <Button asChild size="icon" variant="ghost">
          <a href="#/tasks" aria-label="返回任务">
            <ArrowLeft />
          </a>
        </Button>
        <span className="flex-1 text-fg-muted">
          {project?.name || "独立任务"}
        </span>
        <Button variant="ghost" onClick={() => setEditing(true)}>
          <Pencil />
          编辑任务
        </Button>
        <Button
          disabled={
            dispatch.isPending ||
            (!pending &&
              (!agent || !runtime || !!restriction || row.status === "done"))
          }
          onClick={() => dispatch.mutate()}
        >
          <Play />
          {dispatch.isPending
            ? "分配中…"
            : pending
              ? "恢复执行"
              : runs.data?.length
                ? "重新执行"
                : "分配执行"}
        </Button>
      </header>
      <ErrorNotice
        error={
          task.error ||
          runs.error ||
          activity.error ||
          change.error ||
          dispatch.error ||
          remove.error
        }
        retry={refresh}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid max-w-6xl gap-8 p-6 lg:grid-cols-[1fr_260px] lg:p-10">
          <div className="min-w-0">
            <h1 className="mb-5 break-words text-3xl font-semibold tracking-tight">
              {row.name}
            </h1>
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {row.description || "尚未添加任务说明。"}
            </p>
            {restriction && (
              <p
                role="alert"
                className="mt-4 rounded-md border border-line p-3 text-sm"
              >
                {restriction}
              </p>
            )}
            {(!agent || !runtime) && (
              <p className="mt-5 text-fg-muted">
                编辑任务，选择 Agent 和运行时后即可分配执行。
                <a className="ml-2 underline" href="#/agents">
                  管理 Agents
                </a>
              </p>
            )}
            <section className="mt-10">
              <h2 className="mb-4 text-lg font-medium">
                执行记录{" "}
                <span className="ml-2 text-sm text-fg-muted">
                  {runs.data?.length || 0}
                </span>
              </h2>
              <p className="mb-4 text-sm text-fg-muted">
                每次分配创建独立会话；追问请继续原会话。执行完成后检查结果，再提交验收。
              </p>
              {!runs.data?.length ? (
                <div className="rounded-lg border border-line p-5 text-fg-muted">
                  还没有执行记录。任务说明和项目背景会一起交给 Agent。
                </div>
              ) : (
                <div className="divide-y divide-line rounded-lg border border-line">
                  {runs.data.map((run, index) => (
                    <a
                      key={run.id}
                      href={`#/sessions/${run.id}`}
                      className="flex items-center gap-3 p-4 hover:app-hover"
                    >
                      <Play className="h-4 w-4 text-fg-muted" />
                      <div className="min-w-0 flex-1">
                        <p>
                          执行 {runs.data.length - index} ·{" "}
                          {agents.data?.find((a) => a.id === run.agent_id)
                            ?.name || "Agent"}
                        </p>
                        <p className="mt-1 text-xs text-fg-muted">
                          {dateTime(run.created_at)}
                        </p>
                      </div>
                      <span className="text-sm text-fg-muted">
                        <RunStatus run={run} />
                      </span>
                      <ExternalLink className="h-3.5 w-3.5 text-fg-muted" />
                    </a>
                  ))}
                </div>
              )}
            </section>
            <section className="mt-10">
              <h2 className="mb-5 flex items-center gap-2 text-lg font-medium">
                <MessageSquare className="h-4 w-4" />
                讨论与活动
              </h2>
              <div className="mb-5 space-y-4">
                {activity.data?.map((item) => (
                  <div
                    key={item.id}
                    className={
                      item.type === "comment"
                        ? "rounded-lg border border-line p-4"
                        : "border-l-2 border-line pl-4 text-sm text-fg-muted"
                    }
                  >
                    <div className="mb-1 text-xs text-fg-muted">
                      {dateTime(item.created_at)} ·{" "}
                      {item.type === "comment" ? "工作区备注" : "任务活动"}
                    </div>
                    <p className="whitespace-pre-wrap break-words">
                      {item.message}
                      {item.to && <>：{taskStatuses[item.to]}</>}
                    </p>
                    {item.session_id && (
                      <a
                        className="mt-1 inline-block underline"
                        href={`#/sessions/${item.session_id}`}
                      >
                        查看会话
                      </a>
                    )}
                  </div>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  post.mutate();
                }}
              >
                <Textarea
                  aria-label="任务评论"
                  rows={3}
                  maxLength={10000}
                  placeholder="记录验收意见、决定或下一步…"
                  disabled={post.isPending}
                  value={comment}
                  onChange={(e) => {
                    setComment(e.target.value);
                    setCommentId(crypto.randomUUID());
                  }}
                />
                <ErrorNotice error={post.error} />
                <div className="mt-3 flex items-center justify-between gap-4">
                  <span className="text-xs text-fg-muted">
                    评论用于工作记录；与 Agent 追问请打开会话。
                  </span>
                  <Button
                    disabled={post.isPending || !comment.trim()}
                    type="submit"
                  >
                    添加评论
                  </Button>
                </div>
              </form>
            </section>
          </div>
          <aside className="space-y-6">
            <div>
              <h2 className="mb-3 text-xs text-fg-muted">任务状态</h2>
              <Select
                aria-label="任务状态"
                value={row.status}
                disabled={change.isPending}
                onValueChange={(status) =>
                  change.mutate(status as TaskRecord["status"])
                }
              >
                {Object.entries(taskStatuses).map(([value, label]) => (
                  <SelectOption key={value} value={value}>
                    {label}
                  </SelectOption>
                ))}
              </Select>
              <p className="mt-3 text-xs text-fg-muted">
                任务状态记录交付进度，由你决定；不会请求或阻塞执行权限。
              </p>
            </div>
            <div className="space-y-4 border-t border-line pt-5">
              <div>
                <p className="mb-1 text-xs text-fg-muted">优先级</p>
                {taskPriorities[row.priority]}
              </div>
              <div>
                <p className="mb-1 text-xs text-fg-muted">Agent</p>
                {agent ? (
                  <a href={`#/agents/${agent.id}`} className="hover:underline">
                    {agent.name}
                  </a>
                ) : (
                  "未分配"
                )}
              </div>
              <div>
                <p className="mb-1 text-xs text-fg-muted">运行时</p>
                {runtime?.name || "未选择"}
              </div>
              <div>
                <p className="mb-1 text-xs text-fg-muted">更新时间</p>
                {dateTime(row.updated_at)}
              </div>
              {project?.repository && (
                <a
                  href={project.repository}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 underline"
                >
                  项目仓库
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            {!runs.data?.length && (
              <Button
                variant="ghost"
                disabled={remove.isPending || dispatch.isPending}
                onClick={() => {
                  if (confirm("删除此任务及其评论？")) remove.mutate();
                }}
              >
                删除任务
              </Button>
            )}
          </aside>
        </div>
      </div>
      {editing && <TaskEditor value={row} close={() => setEditing(false)} />}
    </>
  );
}
