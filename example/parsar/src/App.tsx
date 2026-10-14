import { useEffect, useState } from "react";
import { Bot, Cpu, BookOpen, Plug, Server, Moon, Sun, Columns3, Folder, MessageSquare, Clock3 } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Schedules } from "./Schedules";
import { Feishu } from "./Feishu";
import { Tasks } from "./Tasks";
import { TaskDetail } from "./TaskDetail";
import { Projects } from "./Projects";
import { Models } from "./Models";
import { Skills } from "./Skills";
import { MCPs, Runtimes } from "./Resources";
import { Agents } from "./Agents";
import { SessionPage } from "./SessionPage";
import { AgentDetail } from "./AgentDetail";
import { Button } from "./components/ui/button";

export function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "/tasks");
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem("oac-example-theme") === "dark";
    } catch {
      return false;
    }
  });
  const reduce = useReducedMotion();
  useEffect(() => {
    const listener = () => setRoute(location.hash.slice(1) || "/tasks");
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      localStorage.setItem("oac-example-theme", dark ? "dark" : "light");
    } catch {
      /* Theme remains usable without storage. */
    }
  }, [dark]);
  const agentId = route.match(/^\/agents\/([a-f0-9-]{36})$/)?.[1];
  const sessionId = route.match(/^\/sessions\/([a-f0-9-]{36})$/)?.[1];
  const taskId = route.match(/^\/tasks\/([a-f0-9-]{36})$/)?.[1];
  const projectId = new URLSearchParams(route.split("?")[1]).get("project") || "";
  const navigation = [
    { href: "/tasks", label: "任务", icon: Columns3 },
    { href: "/projects", label: "项目", icon: Folder },
    { href: "/agents", label: "Agents", icon: Bot },
    { href: "/models", label: "模型", icon: Cpu },
    { href: "/skills", label: "Skills", icon: BookOpen },
    { href: "/mcps", label: "MCP", icon: Plug },
    { href: "/schedules", label: "定时任务", icon: Clock3 },
    { href: "/feishu", label: "飞书", icon: MessageSquare },
    { href: "/runtimes", label: "运行时", icon: Server },
  ];
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface text-fg sm:flex-row">
      <aside className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface-subtle px-4 py-3 sm:w-52 sm:flex-col sm:flex-nowrap sm:items-stretch sm:gap-0 sm:border-b-0 sm:border-r sm:px-3 sm:py-5">
        <div className="flex items-center gap-2.5 px-2 sm:mb-8">
          <img
            src={dark ? "/parsar-mark-dark.png" : "/parsar-mark-light.png"}
            alt=""
            width={26}
            height={26}
          />
          <span className="text-lg font-semibold tracking-tight">Parsar</span>
        </div>
        <nav
          aria-label="主导航"
          className="order-last flex w-full min-w-0 gap-1 overflow-x-auto sm:order-none sm:w-auto sm:flex-1 sm:flex-col"
        >
          {navigation.map(({ href, label, icon: Icon }) => {
            const selected =
              route.split("?")[0] === href ||
              (href === "/tasks" && !!taskId) ||
              (href === "/agents" && (!!agentId || !!sessionId));
            return (
              <a
                key={href}
                href={`#${href}`}
                aria-current={selected ? "page" : undefined}
                className="relative flex h-9 shrink-0 items-center gap-2.5 rounded-md px-3 text-base text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {selected && (
                  <motion.span
                    layoutId="navigation"
                    className="absolute inset-0 rounded-md border border-line bg-surface app-shadow-control"
                    transition={{ duration: reduce ? 0 : 0.18 }}
                  />
                )}
                <Icon className="relative h-4 w-4 shrink-0" />
                <span className={`relative ${selected ? "text-fg" : ""}`}>
                  {label}
                </span>
              </a>
            );
          })}
        </nav>
        <div className="ml-auto sm:ml-0 sm:mt-auto sm:pt-4">
          <Button
            variant="ghost"
            size="icon"
            aria-label={dark ? "切换浅色" : "切换深色"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {taskId ? (
          <TaskDetail key={taskId} id={taskId} />
        ) : route.split("?")[0] === "/tasks" ? (
          <Tasks key={projectId} projectId={projectId} />
        ) : route === "/projects" ? (
          <Projects />
        ) : sessionId ? (
          <SessionPage key={sessionId} id={sessionId} />
        ) : agentId ? (
          <AgentDetail key={agentId} id={agentId} />
        ) : route === "/models" ? (
          <Models />
        ) : route === "/skills" ? (
          <Skills />
        ) : route === "/mcps" ? (
          <MCPs />
        ) : route === "/schedules" ? (
          <Schedules />
        ) : route === "/feishu" ? (
          <Feishu />
        ) : route === "/runtimes" ? (
          <Runtimes />
        ) : (
          <Agents />
        )}
      </main>
    </div>
  );
}
