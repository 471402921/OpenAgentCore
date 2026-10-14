import { useState } from "react";
import { ModelEditor } from "./ModelEditor";
import { ResourceEditor } from "./Resources";
import { SkillCreate } from "./Skills";
import { Button } from "./components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { api, readHistory } from "./lib/api";
import { tr } from "./lib/i18n";
import { useCapabilities } from "./Capabilities";
import {
  useModels,
  useProviders,
  useMCPs,
  useRuntimes,
  type AgentProfile,
} from "./lib/product";
import { useSkills } from "./Skills";
import { Select, SelectOption } from "./components/ui/select";
import { Textarea } from "./components/ui/textarea";
import { ErrorNotice, Field, Help } from "./components/shared";
export type Configuration = Pick<
  AgentProfile,
  | "model_id"
  | "harness"
  | "instructions"
  | "skill_ids"
  | "skill_versions"
  | "mcp_ids"
  | "runtime_id"
  | "enabled"
  | "ask_user"
  | "capability_ids"
  | "capability_versions"
>;
export const emptyConfiguration: Configuration = {
  model_id: "",
  harness: "claude_sdk",
  instructions: "",
  skill_ids: [],
  mcp_ids: [],
};
export function ConfigurationFields({
  value,
  change,
}: {
  value: Configuration;
  change: (value: Configuration) => void;
}) {
  const [adding, setAdding] = useState("");
  const [resourceId, setResourceId] = useState("");
  const add = (kind: string) => {
    setResourceId(crypto.randomUUID());
    setAdding(kind);
  };
  const capabilities = useCapabilities(),
    runtimes = useRuntimes();
  const models = useModels();
  const providers = useProviders();
  const skills = useSkills();
  const mcps = useMCPs();
  const toggle = (key: "skill_ids" | "mcp_ids", id: string, checked: boolean) =>
    change({
      ...value,
      [key]: checked ? [...value[key], id] : value[key].filter((v) => v !== id),
    });
  return (
    <>
      <h3 className="text-sm font-medium">{tr("职责与指令")}</h3>
      <Field label={tr("指令")} id="config-instructions">
        <Textarea
          id="config-instructions"
          rows={6}
          value={value.instructions}
          onChange={(e) => change({ ...value, instructions: e.target.value })}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.enabled !== false}
          onChange={(e) => change({ ...value, enabled: e.target.checked })}
        />
        {tr("启用 Agent")}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!value.ask_user}
          onChange={(e) => change({ ...value, ask_user: e.target.checked })}
        />
        {tr("允许 Agent 提问业务信息（不用于执行审批）")}
      </label>
      <h3 className="text-sm font-medium">{tr("模型与执行")}</h3>
      <Field label={tr("模型")} id="config-model">
        <Select
          id="config-model"
          value={value.model_id}
          onValueChange={(model_id) => change({ ...value, model_id })}
        >
          <SelectOption value="">{tr("选择模型")}</SelectOption>
          {providers.data?.flatMap(
            (provider) =>
              models.data
                ?.filter((model) => model.provider_id === provider.id)
                .map((model) => (
                  <SelectOption
                    key={model.id}
                    value={model.id}
                    disabled={model.enabled === false}
                  >
                    {provider.name} / {model.name}
                  </SelectOption>
                )) || [],
          )}
        </Select>
        <Button type="button" variant="ghost" onClick={() => add("models")}>
          {tr("添加模型")}
        </Button>
      </Field>
      <Field label={tr("执行引擎")} id="config-harness">
        <Select
          id="config-harness"
          value={value.harness}
          onValueChange={(harness) =>
            change({ ...value, harness: harness as Configuration["harness"] })
          }
        >
          <SelectOption value="claude_sdk">Claude Code</SelectOption>
          <SelectOption value="codex">Codex</SelectOption>
          <SelectOption value="mcode">MiniMax Code</SelectOption>
        </Select>
      </Field>
      {(
        [
          { key: "skill_ids", label: "Skills", rows: skills.data },
          { key: "mcp_ids", label: "MCP", rows: mcps.data },
        ] as const
      ).map((group) => (
        <section key={group.key} className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-medium">{group.label}</h3>
            <Help>
              {group.key === "skill_ids"
                ? tr(
                    "最多选择 8 个技能，可使用默认版本或固定版本。每个新会话自动加载绑定的技能。",
                  )
                : tr("最多选择 8 个 MCP，Agent 从工作环境连接这些服务。")}
            </Help>
            <Button
              type="button"
              variant="ghost"
              disabled={value[group.key].length >= 8}
              onClick={() => add(group.key === "skill_ids" ? "skills" : "mcps")}
            >
              {tr("添加")}
              {group.label}
            </Button>
          </div>
          <div className="max-h-48 space-y-2 overflow-auto">
            {group.rows?.map((row) => (
              <label
                key={row.id}
                className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-base"
              >
                <input
                  type="checkbox"
                  checked={value[group.key].includes(row.id)}
                  disabled={
                    !value[group.key].includes(row.id) &&
                    value[group.key].length >= 8
                  }
                  onChange={(e) => toggle(group.key, row.id, e.target.checked)}
                />
                {row.name}
                {group.key === "skill_ids" &&
                  value.skill_ids.includes(row.id) && (
                    <SkillVersionSelect
                      id={row.id}
                      name={row.name}
                      value={value.skill_versions?.[row.id] || ""}
                      change={(version) =>
                        change({
                          ...value,
                          skill_versions: {
                            ...value.skill_versions,
                            [row.id]: version,
                          },
                        })
                      }
                    />
                  )}
              </label>
            ))}
            {value[group.key]
              .filter(
                (id) => group.rows && !group.rows.some((row) => row.id === id),
              )
              .map((id) => (
                <label key={id} className="flex gap-3 text-base">
                  <input
                    type="checkbox"
                    checked
                    onChange={() => toggle(group.key, id, false)}
                  />
                  {tr("不可用资源")}
                  {id}
                </label>
              ))}
            {group.rows?.length === 0 && (
              <p className="text-base text-fg-muted">
                {tr("尚未添加")}
                {group.label}
              </p>
            )}
          </div>
        </section>
      ))}
      {(
        [
          ["plugin", "Plugins"],
          ["prompt", tr("系统提示词")],
          ["knowledge", tr("知识")],
        ] as const
      ).map(([kind, label]) => (
        <section key={kind} className="space-y-2">
          <h3 className="text-base font-medium">{label}</h3>
          {capabilities.data
            ?.filter((row) => row.kind === kind)
            .map((row) => (
              <div
                className="flex items-center gap-3 border-b border-line py-2"
                key={row.id}
              >
                <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={value.capability_ids?.includes(row.id) || false}
                    onChange={(e) =>
                      change({
                        ...value,
                        capability_ids: e.target.checked
                          ? [...(value.capability_ids || []), row.id]
                          : value.capability_ids?.filter((id) => id !== row.id),
                      })
                    }
                  />
                  {row.name}
                  {row.deprecated ? tr("（已停用）") : ""}
                </label>
                {value.capability_ids?.includes(row.id) && (
                  <Select
                    aria-label={tr("{{value0}} 版本", { value0: row.name })}
                    value={value.capability_versions?.[row.id] || ""}
                    onValueChange={(version) =>
                      change({
                        ...value,
                        capability_versions: {
                          ...value.capability_versions,
                          [row.id]: version,
                        },
                      })
                    }
                  >
                    <SelectOption value="">{tr("默认版本")}</SelectOption>
                    {row.versions.map((version) => (
                      <SelectOption
                        key={version.version}
                        value={version.version}
                      >
                        v{version.version}
                      </SelectOption>
                    ))}
                  </Select>
                )}
              </div>
            ))}
        </section>
      ))}
      <Field label={tr("默认环境模板")} id="config-runtime">
        <Select
          id="config-runtime"
          value={value.runtime_id || ""}
          onValueChange={(runtime_id) => change({ ...value, runtime_id })}
        >
          <SelectOption value="">{tr("开始会话时选择")}</SelectOption>
          {runtimes.data?.map((row) => (
            <SelectOption key={row.id} value={row.id}>
              {row.name}
            </SelectOption>
          ))}
        </Select>
        <Button type="button" variant="ghost" onClick={() => add("runtimes")}>
          {tr("添加环境模板")}
        </Button>
      </Field>
      {adding === "models" && (
        <ModelEditor
          value={{
            id: resourceId,
            revision: 0,
            name: "",
            model: "",
            provider_id: "",
          }}
          close={() => setAdding("")}
          onSaved={(model_id) => change({ ...value, model_id })}
        />
      )}
      {adding === "skills" && (
        <SkillCreate
          close={() => setAdding("")}
          onSaved={(id) =>
            change({ ...value, skill_ids: [...value.skill_ids, id] })
          }
        />
      )}
      {(adding === "mcps" || adding === "runtimes") && (
        <ResourceEditor
          kind={adding}
          title={adding === "mcps" ? "MCP" : tr("环境模板")}
          value={
            adding === "mcps"
              ? { id: resourceId, revision: 0, name: "", label: "", url: "" }
              : {
                  id: resourceId,
                  revision: 0,
                  name: "",
                  environment: "openai_hosted",
                }
          }
          close={() => setAdding("")}
          onSaved={(id) =>
            change(
              adding === "mcps"
                ? { ...value, mcp_ids: [...value.mcp_ids, id] }
                : { ...value, runtime_id: id },
            )
          }
        />
      )}
      <ErrorNotice
        error={
          providers.error ||
          models.error ||
          skills.error ||
          mcps.error ||
          capabilities.error ||
          runtimes.error
        }
      />
    </>
  );
}
function SkillVersionSelect({
  id,
  name,
  value,
  change,
}: {
  id: string;
  name: string;
  value: string;
  change: (version: string) => void;
}) {
  const versions = useQuery({
    queryKey: ["skill-versions", id],
    queryFn: ({ signal }) =>
      readHistory((options) => api.listSkillVersions(id, options), signal),
  });
  return (
    <div className="ml-auto">
      <Select
        aria-label={`${name} ${tr("版本")}`}
        value={value}
        onValueChange={change}
      >
        <SelectOption value="">{tr("默认版本")}</SelectOption>
        {versions.data?.map((row) => (
          <SelectOption key={row.id} value={row.version}>
            v{row.version}
          </SelectOption>
        ))}
      </Select>
      <ErrorNotice error={versions.error} />
    </div>
  );
}
