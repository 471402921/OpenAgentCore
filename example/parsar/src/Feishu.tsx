import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { product, useAgents, useRuntimes, useProjects } from "./lib/product";
import { PageHeader, Field, ErrorNotice } from "./components/shared";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select, SelectOption } from "./components/ui/select";
import { EmptyState } from "./components/ui/empty-state";
import { dateTime } from "./lib/api";
interface FeishuConfig {
  revision: number;
  app_id: string;
  app_secret?: string;
  has_app_secret: boolean;
  enabled: boolean;
  routes: {
    chat_id: string;
    project_id: string;
    agent_id: string;
    runtime_id: string;
    allow_agent_selection?: boolean;
  }[];
}
interface Delivery {
  id: string;
  direction: string;
  chat_id: string;
  state: string;
  error?: string;
  created_at: number;
  attempts: number;
  task_id?: string;
}
const states: Record<string, string> = {
  stopped: "已停用",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  error: "连接失败，请检查机器人配置",
  core_unavailable: "Core 暂不可用",
  queued: "等待处理",
  submitting: "正在确认",
  delivered: "已送达",
  failed: "需要处理",
  rejected: "已拒绝",
};
export function Feishu() {
  const cache = useQueryClient();
  const retry = useMutation({
    mutationFn: (row: Delivery) =>
      product(`feishu/deliveries/${row.direction}/${row.id}`, "PUT", {}),
    onSettled: () =>
      void cache.invalidateQueries({ queryKey: ["feishu-deliveries"] }),
  });
  const config = useQuery({
    queryKey: ["feishu"],
    queryFn: () => product<FeishuConfig>("feishu"),
  });
  const status = useQuery({
    queryKey: ["feishu-status"],
    queryFn: () =>
      product<{ state: string; updated_at?: number }>("feishu/status"),
    refetchInterval: 5000,
  });
  const deliveries = useQuery({
    queryKey: ["feishu-deliveries"],
    queryFn: () => product<Delivery[]>("feishu/deliveries"),
    refetchInterval: 5000,
  });
  return (
    <>
      <PageHeader title="飞书接入">
        <span className="text-sm text-fg-muted" role="status">
          {states[status.data?.state || "stopped"] || status.data?.state}
        </span>
      </PageHeader>
      <ErrorNotice
        error={config.error || status.error || deliveries.error || retry.error}
        retry={() => void config.refetch()}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl space-y-8 p-6 lg:p-10">
          <div>
            <h2 className="text-xl font-semibold">让任务从团队的对话开始</h2>
            <p className="mt-3 leading-relaxed text-fg-muted">
              在允许的飞书群中 @机器人 描述工作，Parsar 会创建任务并交给
              Agent。结果回到原话题；在话题中继续 @机器人 即可追问。
            </p>
          </div>
          <details className="rounded-lg border border-line p-5">
            <summary className="cursor-pointer font-medium">
              配置机器人 · 三步接入
            </summary>
            <ol className="mt-4 list-decimal space-y-3 pl-5 text-fg-muted">
              <li>
                在飞书开放平台创建企业自建应用，开启机器人能力。申请接收群内
                @机器人 消息和以应用身份发送消息的权限。
              </li>
              <li>
                事件订阅选择「使用长连接接收事件」，订阅
                im.message.receive_v1。发布应用并把机器人加入测试群。
              </li>
              <li>
                填写应用凭据，添加允许的群及其
                Agent、运行时，然后启用。只接收这些群的 @机器人 消息；私聊和
                @所有人 不触发执行。
              </li>
            </ol>
            <p className="mt-4 text-sm text-fg-muted">
              无需公网回调。App Secret 仅存于服务器。飞书群成员可触发对应
              Agent；请只开放给可信群。
            </p>
          </details>
          {config.data ? (
            <FeishuEditor key={config.data.revision} value={config.data} />
          ) : (
            <EmptyState title="正在加载…" />
          )}
          <section>
            <h2 className="mb-4 text-lg font-medium">最近投递</h2>
            <p className="mb-4 text-sm text-fg-muted">
              连接中断会按相同请求标识重试。超过重试上限或飞书去重窗口的记录会保留为「需要处理」，避免重复发送。
            </p>
            {!deliveries.data?.length ? (
              <EmptyState
                size="compact"
                title="尚无消息"
                description="启用后，在允许的飞书群中 @机器人 发送第一项任务。"
              />
            ) : (
              <div className="divide-y divide-line rounded-lg border border-line">
                {deliveries.data.map((row) => (
                  <div key={`${row.direction}-${row.id}`} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {row.direction === "inbound"
                          ? "飞书 → Agent"
                          : "Agent → 飞书"}
                      </span>
                      <span className="text-sm">
                        {states[row.state] || row.state}
                      </span>
                    </div>
                    <p className="mt-1 break-all text-xs text-fg-muted">
                      {row.chat_id} · {dateTime(row.created_at / 1000)} · 尝试{" "}
                      {row.attempts} 次
                    </p>
                    {row.error && <p className="mt-2 text-sm">{row.error}</p>}
                    {row.state === "failed" && (
                      <Button
                        className="mt-2 mr-3"
                        variant="outline"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(row)}
                      >
                        重试此投递
                      </Button>
                    )}
                    {row.task_id && (
                      <a
                        className="mt-2 inline-block text-sm underline"
                        href={`#/tasks/${row.task_id}`}
                      >
                        查看任务
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
function FeishuEditor({ value }: { value: FeishuConfig }) {
  const cache = useQueryClient(),
    agents = useAgents(),
    runtimes = useRuntimes(),
    projects = useProjects();
  const [form, setForm] = useState({ ...value, app_secret: "" });
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => product<FeishuConfig>("feishu", "PUT", form),
    onSuccess: (config) => {
      setForm({ ...config, app_secret: "" });
      setSaved(true);
      cache.setQueryData(["feishu"], config);
      void cache.invalidateQueries({ queryKey: ["feishu-status"] });
    },
  });
  const updateRoute = (index: number, field: string, value: string | boolean) =>
    setForm({
      ...form,
      routes: form.routes.map((row, i) =>
        i === index ? { ...row, [field]: value } : row,
      ),
    });
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="App ID" id="feishu-app">
          <Input
            id="feishu-app"
            autoComplete="off"
            value={form.app_id}
            onChange={(e) => setForm({ ...form, app_id: e.target.value })}
            placeholder="cli_…"
          />
        </Field>
        <Field label="App Secret" id="feishu-secret">
          <Input
            id="feishu-secret"
            type="password"
            autoComplete="new-password"
            value={form.app_secret}
            onChange={(e) => setForm({ ...form, app_secret: e.target.value })}
            placeholder={
              form.has_app_secret ? "已保存，留空保留" : "输入应用密钥"
            }
          />
        </Field>
      </div>
      <div className="flex items-center justify-between">
        <h3 className="font-medium">允许的群与分配规则</h3>
        <Button
          type="button"
          variant="outline"
          disabled={form.routes.length >= 20}
          onClick={() =>
            setForm({
              ...form,
              routes: [
                ...form.routes,
                { chat_id: "", project_id: "", agent_id: "", runtime_id: "" },
              ],
            })
          }
        >
          <Plus />
          添加群
        </Button>
      </div>
      {form.routes.map((route, index) => (
        <div
          key={index}
          className="space-y-4 rounded-lg border border-line p-4"
        >
          <div className="flex gap-3">
            <Input
              aria-label={`群 ID ${index + 1}`}
              required
              placeholder="oc_…"
              value={route.chat_id}
              onChange={(e) => updateRoute(index, "chat_id", e.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`移除群 ${index + 1}`}
              onClick={() =>
                setForm({
                  ...form,
                  routes: form.routes.filter((_, i) => i !== index),
                })
              }
            >
              <Trash2 />
            </Button>
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={!!route.allow_agent_selection}
              onChange={(e) =>
                updateRoute(index, "allow_agent_selection", e.target.checked)
              }
            />
            <span>
              允许群成员切换 Agent（共享机器人）
              <span className="mt-1 block text-fg-muted">
                用 /list 和 /select 选择此安装中的 Agent；关闭时固定使用下方
                Agent。选择按群成员保存，仅影响新任务。
              </span>
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <Select
              aria-label={`群项目 ${index + 1}`}
              value={route.project_id}
              onValueChange={(value) => updateRoute(index, "project_id", value)}
            >
              <SelectOption value="">独立任务</SelectOption>
              {projects.data?.map((row) => (
                <SelectOption key={row.id} value={row.id}>
                  {row.name}
                </SelectOption>
              ))}
            </Select>
            <Select
              aria-label={`群 Agent ${index + 1}`}
              value={route.agent_id}
              onValueChange={(value) => updateRoute(index, "agent_id", value)}
            >
              <SelectOption value="">选择 Agent</SelectOption>
              {agents.data?.map((row) => (
                <SelectOption key={row.id} value={row.id}>
                  {row.name}
                </SelectOption>
              ))}
            </Select>
            <Select
              aria-label={`群运行时 ${index + 1}`}
              value={route.runtime_id}
              onValueChange={(value) => updateRoute(index, "runtime_id", value)}
            >
              <SelectOption value="">选择运行时</SelectOption>
              {runtimes.data
                ?.filter((row) => row.environment !== "self_hosted")
                .map((row) => (
                  <SelectOption key={row.id} value={row.id}>
                    {row.name}
                  </SelectOption>
                ))}
            </Select>
          </div>
        </div>
      ))}
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        启用飞书机器人
      </label>
      <p className="text-sm text-fg-muted">
        同一话题继续同一个执行会话。配置更改作用于新话题。支持
        /cancel、/review、/done、/reopen；结果回传文本摘要，文件可在 Web
        会话中下载。
      </p>
      <ErrorNotice
        error={save.error || agents.error || runtimes.error || projects.error}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "保存中…" : "保存飞书配置"}
        </Button>
        {saved && <span role="status">配置已保存</span>}
      </div>
    </form>
  );
}
