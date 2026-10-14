import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Folder, Plus, Pencil } from "lucide-react";
import {
  product,
  useProjects,
  useTasks,
  type ProjectRecord,
} from "./lib/product";
import { PageHeader, Field, ErrorNotice } from "./components/shared";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { EmptyState } from "./components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./components/ui/dialog";

export function Projects() {
  const projects = useProjects(),
    tasks = useTasks();
  const [editing, setEditing] = useState<Partial<ProjectRecord> | null>(null);
  return (
    <>
      <PageHeader title="项目">
        <Button onClick={() => setEditing({})}>
          <Plus />
          新建项目
        </Button>
      </PageHeader>
      <ErrorNotice
        error={projects.error || tasks.error}
        retry={() => void projects.refetch()}
      />
      <div className="flex-1 overflow-auto p-6">
        <p className="mb-6 text-fg-muted">
          把目标、仓库和背景放在一起，让每次任务从同一份上下文开始。
        </p>
        {projects.isPending ? (
          <EmptyState title="正在加载…" />
        ) : !projects.data?.length ? (
          <EmptyState
            title="从一个项目开始"
            description="记录项目背景，然后把具体工作交给 Agent。"
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects.data.map((project) => {
              const related =
                tasks.data?.filter((task) => task.project_id === project.id) ||
                [];
              const done = related.filter(
                (task) => task.status === "done",
              ).length;
              return (
                <article
                  key={project.id}
                  className="rounded-lg border border-line p-5"
                >
                  <div className="mb-4 flex items-center justify-between">
                    <Folder className="h-5 w-5 text-fg-muted" />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`编辑项目 ${project.name}`}
                      onClick={() => setEditing(project)}
                    >
                      <Pencil />
                    </Button>
                  </div>
                  <a
                    href={`#/tasks?project=${project.id}`}
                    className="text-lg font-semibold hover:underline"
                  >
                    {project.name}
                  </a>
                  <p className="mt-2 line-clamp-3 min-h-16 whitespace-pre-wrap text-fg-muted">
                    {project.description || "尚未添加项目背景"}
                  </p>
                  <div className="mt-5 flex justify-between text-sm text-fg-muted">
                    <span>{related.length} 个任务</span>
                    <span>{done} 已完成</span>
                  </div>
                  <progress
                    className="mt-2 h-1.5 w-full accent-accent"
                    max={Math.max(related.length, 1)}
                    value={done}
                    aria-label={`${project.name} 完成进度`}
                  />
                </article>
              );
            })}
          </div>
        )}
      </div>
      {editing && (
        <ProjectEditor
          key={editing.id || "new"}
          value={editing}
          close={() => setEditing(null)}
        />
      )}
    </>
  );
}
function ProjectEditor({
  value,
  close,
}: {
  value: Partial<ProjectRecord>;
  close: () => void;
}) {
  const cache = useQueryClient();
  const [form, setForm] = useState(() => ({
    id: crypto.randomUUID(),
    name: "",
    description: "",
    repository: "",
    ...value,
  }));
  const save = useMutation({
    mutationFn: () => product(`projects/${form.id}`, "PUT", form),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["projects"] });
      close();
    },
  });
  const remove = useMutation({
    mutationFn: () => product(`projects/${form.id}`, "DELETE", form),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["projects"] });
      close();
    },
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
          <DialogTitle>{value.id ? "编辑项目" : "新建项目"}</DialogTitle>
        </DialogHeader>
        <form
          id="project-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label="项目名称" id="project-name">
            <Input
              id="project-name"
              required
              maxLength={80}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="项目背景" id="project-description">
            <Textarea
              id="project-description"
              rows={6}
              maxLength={40000}
              placeholder="目标、约束、交付标准和 Agent 需要了解的背景"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </Field>
          <Field label="仓库地址（可选）" id="project-repository">
            <Input
              id="project-repository"
              type="url"
              placeholder="https://github.com/team/project"
              value={form.repository}
              onChange={(e) => setForm({ ...form, repository: e.target.value })}
            />
          </Field>
          <p className="text-sm text-fg-muted">
            项目背景会随任务发送。仓库地址作为上下文；访问权限和检出由执行环境负责。
          </p>
          <ErrorNotice error={save.error || remove.error} />
        </form>
        <DialogFooter>
          {value.id && (
            <Button
              variant="ghost"
              disabled={save.isPending || remove.isPending}
              onClick={() => {
                if (confirm("删除这个项目？项目有任务时不能删除。"))
                  remove.mutate();
              }}
            >
              删除项目
            </Button>
          )}
          <Button
            type="submit"
            form="project-form"
            disabled={save.isPending || remove.isPending}
          >
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
