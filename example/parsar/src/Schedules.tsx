import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Clock3 } from "lucide-react";
import { product, useTasks } from "./lib/product";
import { PageHeader, Field, ErrorNotice } from "./components/shared";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select, SelectOption } from "./components/ui/select";
import { EmptyState } from "./components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./components/ui/dialog";
import { dateTime } from "./lib/api";
interface Schedule {
  id: string;
  name: string;
  revision: number;
  task_id: string;
  interval_minutes: number;
  enabled: boolean;
  next_at: number;
  last_task_id?: string;
  last_error?: string;
  pending?: { task_id: string };
}
export function Schedules() {
  const schedules = useQuery({
      queryKey: ["schedules"],
      queryFn: () => product<Schedule[]>("schedules"),
      refetchInterval: 5000,
    }),
    tasks = useTasks(),
    cache = useQueryClient();
  const [editing, setEditing] = useState<Partial<Schedule> | null>(null);
  const toggle = useMutation({
    mutationFn: (row: Schedule) =>
      product(`schedules/${row.id}`, "PUT", { ...row, enabled: !row.enabled }),
    onSettled: () => void cache.invalidateQueries({ queryKey: ["schedules"] }),
  });
  return (
    <>
      <PageHeader title="定时任务">
        <Button onClick={() => setEditing({})}>
          <Plus />
          新建计划
        </Button>
      </PageHeader>
      <ErrorNotice error={schedules.error || tasks.error || toggle.error} />
      <div className="flex-1 overflow-auto p-6">
        <p className="mb-6 text-fg-muted">
          复用任务作为模板，定期创建独立任务和执行会话。错过的间隔合并为一次；上次执行未结束时跳过，避免重叠。
        </p>
        {!schedules.data?.length ? (
          <EmptyState
            icon={Clock3}
            title="把重复的工作交给 Agent"
            description="例如每天检查依赖、汇总反馈，或定期审查项目。先创建一个包含 Agent 和运行时的任务，再设为模板。"
          />
        ) : (
          <div className="space-y-3">
            {schedules.data.map((row) => (
              <article
                key={row.id}
                className="rounded-lg border border-line p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="font-medium">{row.name}</h2>
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={() => setEditing(row)}>
                      编辑计划
                    </Button>
                    <Button
                      variant="outline"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate(row)}
                    >
                      {row.enabled ? "暂停" : "启用"}
                    </Button>
                  </div>
                </div>
                <p className="mt-2 text-sm text-fg-muted">
                  每 {row.interval_minutes} 分钟 ·{" "}
                  {row.enabled
                    ? `下次 ${dateTime(row.next_at / 1000)}`
                    : "已暂停"}{" "}
                  · 模板：
                  {tasks.data?.find((t) => t.id === row.task_id)?.name ||
                    "不可用"}
                </p>
                {row.last_error && (
                  <p className="mt-3 text-sm">{row.last_error}</p>
                )}
                {row.last_task_id && (
                  <a
                    className="mt-3 inline-block text-sm underline"
                    href={`#/tasks/${row.last_task_id}`}
                  >
                    查看最近任务
                  </a>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
      {editing && (
        <ScheduleEditor value={editing} close={() => setEditing(null)} />
      )}
    </>
  );
}
function ScheduleEditor({
  value,
  close,
}: {
  value: Partial<Schedule>;
  close: () => void;
}) {
  const tasks = useTasks(),
    cache = useQueryClient();
  const [form, setForm] = useState(() => ({
    id: crypto.randomUUID(),
    name: "",
    task_id: "",
    interval_minutes: 1440,
    enabled: true,
    ...value,
  }));
  const finish = () => {
    void cache.invalidateQueries({ queryKey: ["schedules"] });
    close();
  };
  const save = useMutation({
    mutationFn: () => product(`schedules/${form.id}`, "PUT", form),
    onSuccess: finish,
  });
  const remove = useMutation({
    mutationFn: () => product(`schedules/${form.id}`, "DELETE", form),
    onSuccess: finish,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending && !remove.isPending) close();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{value.id ? "编辑计划" : "新建计划"}</DialogTitle>
        </DialogHeader>
        <form
          id="schedule-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="计划名称" id="schedule-name">
            <Input
              id="schedule-name"
              required
              maxLength={80}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="任务模板" id="schedule-task">
            <Select
              id="schedule-task"
              value={form.task_id}
              onValueChange={(task_id) => setForm({ ...form, task_id })}
            >
              <SelectOption value="">选择任务</SelectOption>
              {tasks.data?.map((row) => (
                <SelectOption key={row.id} value={row.id}>
                  {row.name}
                </SelectOption>
              ))}
            </Select>
          </Field>
          <Field label="间隔（分钟）" id="schedule-interval">
            <Input
              id="schedule-interval"
              type="number"
              min={5}
              max={525600}
              required
              value={form.interval_minutes}
              onChange={(e) =>
                setForm({ ...form, interval_minutes: Number(e.target.value) })
              }
            />
          </Field>
          <p className="text-sm text-fg-muted">
            服务器运行时生效。每次读取模板的当前配置；已发出的请求保持不变。暂时断线会自动恢复原执行；配置被拒绝时暂停，修正后可重新启用。
          </p>
          <ErrorNotice error={save.error || remove.error} />
        </form>
        <DialogFooter>
          {value.id && (
            <Button
              variant="ghost"
              disabled={remove.isPending || save.isPending}
              onClick={() => {
                if (confirm("删除此计划？已创建的任务会保留。"))
                  remove.mutate();
              }}
            >
              删除计划
            </Button>
          )}
          <Button
            type="submit"
            form="schedule-form"
            disabled={save.isPending || remove.isPending}
          >
            保存计划
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
