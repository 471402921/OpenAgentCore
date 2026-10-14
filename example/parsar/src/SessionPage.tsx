import { SingleSlot } from "./components/plugin/SlotRenderer";
import { tr } from "./lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { product, type SessionRecord } from "./lib/product";
import { SessionDetail } from "./SessionDetail";
import { EmptyState } from "./components/ui/empty-state";
import { Button } from "./components/ui/button";
import { ErrorNotice } from "./components/shared";
export function SessionPage({ id }: { id: string }) {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["session-record", id],
    queryFn: () => product<SessionRecord>(`sessions/${id}`),
  });
  const resume = useMutation({
    mutationFn: () => product<SessionRecord>(`sessions/${id}`, "PUT", {}),
    onSuccess: (record) => {
      cache.setQueryData(["session-record", id], record);
      void cache.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  if (query.data?.deleted_at) return <EmptyState title={tr("此会话已删除")} />;
  if (query.data?.core_session_id)
    return (
      <SingleSlot
        slotId="workspace.content"
        context={{ session: query.data }}
        fallback={
          <SessionDetail
            key={query.data.core_session_id}
            id={query.data.core_session_id}
            agentId={query.data.agent_id}
            machine={query.data.self_hosted}
            taskId={query.data.task_id}
            brief={query.data.brief}
          />
        }
      />
    );
  return (
    <div className="p-6">
      <Button asChild variant="ghost">
        <a
          href={
            query.data?.task_id
              ? `#/tasks/${query.data.task_id}`
              : `#/agents/${query.data?.agent_id || ""}`
          }
        >
          {query.data?.task_id ? tr("返回任务") : tr("返回 Agent")}
        </a>
      </Button>
      <ErrorNotice error={query.error || resume.error} />
      <EmptyState
        title={query.isPending ? tr("正在加载\u2026") : tr("会话创建尚未确认")}
      />
      {query.data && (
        <Button disabled={resume.isPending} onClick={() => resume.mutate()}>
          {resume.isPending ? tr("恢复中\u2026") : tr("恢复创建")}
        </Button>
      )}
    </div>
  );
}
