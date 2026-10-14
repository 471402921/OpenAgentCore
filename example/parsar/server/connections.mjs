import { createHash, randomUUID } from "node:crypto";
import { AppError, text, uuid } from "./store.mjs";

const key = (...parts) =>
  createHash("sha256").update(parts.join("\n")).digest("hex");
const scopesOf = (value) =>
  [
    ...new Set(
      text(value || "", "授权范围", 3000)
        .split(/\s+/)
        .filter(Boolean),
    ),
  ].sort();
export function connectionRequirement(store, value) {
  if (!value) return undefined;
  const bot = store.get("feishu_bots", value.bot_id);
  const scopes = scopesOf(value.scopes);
  if (
    value.service !== "feishu" ||
    !bot?.app_id ||
    !bot.app_secret ||
    !scopes.length ||
    scopes.length > 50 ||
    scopes.some((s) => !/^[a-zA-Z0-9_:.-]+$/.test(s))
  )
    throw new AppError(400, "请选择已配置的飞书应用和有效的授权范围。");
  return {
    service: "feishu",
    bot_id: bot.id,
    app_id: bot.app_id,
    scopes: scopes.join(" "),
  };
}
export function connectionOwner(store, sessionId) {
  const thread = store
    .list("feishu_threads")
    .find((t) => t.session_id === sessionId);
  return thread
    ? { kind: "feishu", app_id: thread.app_id, subject_id: thread.sender_id }
    : { kind: "local" };
}
const ownerKey = (owner) =>
  owner.kind === "local" ? "local" : key(owner.app_id, owner.subject_id);
const safeLogin = (row) =>
  row && {
    id: row.id,
    status: row.status,
    verification_url: row.verification_url,
    user_code: row.user_code,
    expires_at: row.expires_at,
    error: row.error,
  };
const safeConnection = (row) =>
  row && {
    id: row.id,
    service: "feishu",
    app_id: row.app_id,
    subject_id: row.subject_id,
    name: row.name,
    status: row.status,
    revocation_pending: row.revocation_pending,
    scopes: row.scopes,
    expires_at: row.expires_at,
  };

// OAuth device authorization follows the pinned official CLI's RFC 8628 flow.
// App secrets and refresh tokens stay in the product store, never in a Session.
export function userConnections(store, fetchImpl = fetch) {
  const locks = new Map();
  const locked = (id, fn) => {
    if (!locks.has(id))
      locks.set(
        id,
        Promise.resolve()
          .then(fn)
          .finally(() => locks.delete(id)),
      );
    return locks.get(id);
  };
  const app = (requirement) => {
    const bot = store.get("feishu_bots", requirement.bot_id);
    if (!bot?.app_secret || bot.app_id !== requirement.app_id)
      throw new AppError(409, "飞书应用配置已改变，请重新选择连接应用。");
    return bot;
  };
  const request = async (url, options) => {
    let response, value;
    try {
      response = await fetchImpl(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      const raw = await response.text();
      if (raw.length > 65536) throw new Error();
      value = raw ? JSON.parse(raw) : {};
    } catch {
      throw new AppError(502, "无法连接飞书授权服务，请稍后重试。");
    }
    if (!response.ok && !value.error)
      throw new AppError(502, "飞书授权服务暂不可用。");
    return value;
  };
  const accounts = (bot) =>
    `https://accounts.${bot.brand === "lark" ? "larksuite.com" : "feishu.cn"}`;
  const post = (bot, path, fields, basic = false) =>
    request(accounts(bot) + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(basic
          ? {
              Authorization: `Basic ${Buffer.from(`${bot.app_id}:${bot.app_secret}`).toString("base64")}`,
            }
          : {}),
      },
      body: new URLSearchParams(fields),
    });
  const tokenFields = (bot, fields) => ({
    client_id: bot.app_id,
    client_secret: bot.app_secret,
    ...fields,
  });
  const tokenData = (value, old = {}) => {
    if (
      typeof value.access_token !== "string" ||
      !value.access_token ||
      (value.token_type && value.token_type.toLowerCase() !== "bearer") ||
      !(Number(value.expires_in) > 0)
    )
      throw new AppError(502, "飞书未返回受支持的用户授权，请重新连接。");
    return {
      access_token: value.access_token,
      refresh_token: value.refresh_token || old.refresh_token,
      expires_at: Date.now() + Number(value.expires_in) * 1000,
      refresh_expires_at: value.refresh_token_expires_in
        ? Date.now() + Number(value.refresh_token_expires_in) * 1000
        : old.refresh_expires_at,
      scopes: typeof value.scope === "string" ? value.scope : old.scopes || "",
    };
  };
  const selected = (requirement, owner) => {
    if (owner.kind === "feishu") {
      if (owner.app_id !== requirement.app_id)
        throw new AppError(400, "飞书入口与 Agent 的连接应用必须一致。");
      return store.get(
        "user_connections",
        key(requirement.app_id, owner.subject_id),
      );
    }
    const binding = store.get(
      "connection_bindings",
      key("local", requirement.app_id),
    );
    return binding && store.get("user_connections", binding.connection_id);
  };
  const hasScopes = (row, requirement) =>
    scopesOf(requirement.scopes).every((s) => scopesOf(row.scopes).includes(s));
  const refresh = (row, bot) =>
    locked(`refresh:${row.id}`, async () => {
      row = store.get("user_connections", row.id);
      if (row.status !== "connected" || row.expires_at > Date.now() + 120000)
        return row;
      if (
        !row.refresh_token ||
        (row.refresh_expires_at && row.refresh_expires_at <= Date.now())
      ) {
        row = {
          ...row,
          status: "reconnect_required",
          access_token: undefined,
          refresh_token: undefined,
        };
      } else {
        const value = await request(accounts(bot) + "/oauth/v3/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            tokenFields(bot, {
              grant_type: "refresh_token",
              refresh_token: row.refresh_token,
            }),
          ),
        });
        if (value.error) {
          if (
            !["invalid_grant", "invalid_token", "access_denied"].includes(
              value.error,
            )
          )
            throw new AppError(502, "飞书授权续期暂时失败，请稍后重试。");
          row = {
            ...row,
            status: "reconnect_required",
            access_token: undefined,
            refresh_token: undefined,
          };
        } else row = { ...row, ...tokenData(value, row) };
      }
      // Disconnect may run while the provider request is in flight.
      if (store.get("user_connections", row.id)?.generation !== row.generation)
        return store.get("user_connections", row.id);
      store.put("user_connections", row);
      return row;
    });
  const revoke = (row) =>
    locked(`revoke:${row.id}`, async () => {
      row = store.get("user_connections", row.id);
      if (!row?.revocation_pending) return;
      const bot = app(row);
      for (const [field, hint] of [
        ["refresh_token", "refresh_token"],
        ["access_token", "access_token"],
      ]) {
        if (!row[field]) continue;
        const value = await post(
          bot,
          "/oauth/v1/revoke",
          tokenFields(bot, { token: row[field], token_type_hint: hint }),
        );
        if (value.error || (value.code && value.code !== 0))
          throw new AppError(502, "撤销飞书授权暂未确认，将自动重试。");
      }
      if (store.get("user_connections", row.id)?.generation === row.generation)
        store.put("user_connections", {
          ...row,
          access_token: undefined,
          refresh_token: undefined,
          revocation_pending: false,
        });
    });
  const begin = (requirement, owner, force = false) =>
    locked(`login:${ownerKey(owner)}:${requirement.app_id}`, async () => {
      if (selected(requirement, owner)?.revocation_pending)
        throw new AppError(409, "正在撤销旧授权，请稍后重新连接。");
      const existing = store
        .list("connection_logins")
        .find(
          (r) =>
            r.owner_key === ownerKey(owner) &&
            r.requirement.app_id === requirement.app_id &&
            r.status === "pending" &&
            r.expires_at > Date.now() &&
            r.requirement.scopes === requirement.scopes,
        );
      if (existing && !force) return safeLogin(existing);
      const bot = app(requirement);
      const value = await post(
        bot,
        "/oauth/v1/device_authorization",
        {
          client_id: bot.app_id,
          scope: [
            ...new Set([...scopesOf(requirement.scopes), "offline_access"]),
          ].join(" "),
        },
        true,
      );
      if (value.error || !value.device_code || !value.verification_uri)
        throw new AppError(
          502,
          "无法发起飞书授权，请检查应用的用户权限是否已开通。",
        );
      const url = new URL(
        value.verification_uri_complete || value.verification_uri,
      );
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        ![
          "accounts.feishu.cn",
          "open.feishu.cn",
          "accounts.larksuite.com",
          "open.larksuite.com",
        ].includes(url.hostname)
      )
        throw new AppError(502, "飞书返回了无效授权地址。");
      const row = {
        id: randomUUID(),
        owner,
        owner_key: ownerKey(owner),
        requirement,
        status: "pending",
        device_code: value.device_code,
        verification_url: url.href,
        user_code: value.user_code,
        expires_at:
          Date.now() + Math.min(Number(value.expires_in) || 240, 1800) * 1000,
        interval: Math.max(5, Number(value.interval) || 5),
        next_at: Date.now() + 5000,
      };
      store.transaction(() => {
        for (const old of store
          .list("connection_logins")
          .filter(
            (r) =>
              r.owner_key === row.owner_key &&
              r.requirement.app_id === requirement.app_id &&
              r.status === "pending",
          ))
          store.put("connection_logins", {
            ...old,
            status: "cancelled",
            device_code: undefined,
          });
        store.put("connection_logins", row);
      });
      return safeLogin(row);
    });
  const poll = (id) =>
    locked(`poll:${id}`, async () => {
      let row = store.get("connection_logins", id);
      if (!row || row.status !== "pending") return;
      if (row.expires_at <= Date.now()) {
        store.put("connection_logins", {
          ...row,
          status: "expired",
          device_code: undefined,
        });
        return;
      }
      if (row.next_at > Date.now()) return;
      const bot = app(row.requirement);
      row = { ...row, next_at: Date.now() + row.interval * 1000 };
      store.put("connection_logins", row);
      const value =
        row.pending_tokens ||
        (await post(
          bot,
          "/oauth/v3/token",
          tokenFields(bot, {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: row.device_code,
          }),
        ));
      if (store.get("connection_logins", id)?.status !== "pending") return;
      if (value.error) {
        if (value.error === "authorization_pending") return;
        if (value.error === "slow_down") {
          store.put("connection_logins", {
            ...row,
            interval: Math.min(row.interval + 5, 60),
            next_at: Date.now() + (row.interval + 5) * 1000,
          });
          return;
        }
        store.put("connection_logins", {
          ...row,
          status: value.error === "expired_token" ? "expired" : "denied",
          error: "授权未完成，请重新连接。",
          device_code: undefined,
        });
        return;
      }
      if (!row.pending_tokens) {
        row = {
          ...row,
          pending_tokens: tokenData(value),
          device_code: undefined,
        };
        store.put("connection_logins", row);
      }
      const tokens = row.pending_tokens;
      const info = await request(
        `https://open.${bot.brand === "lark" ? "larksuite.com" : "feishu.cn"}/open-apis/authen/v1/user_info`,
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      );
      const user = info.data;
      if (info.code !== 0 || !user?.open_id)
        throw new AppError(502, "无法确认授权账号身份，请重新连接。");
      if (
        row.owner.kind === "feishu" &&
        user.open_id !== row.owner.subject_id
      ) {
        store.put("connection_logins", {
          ...row,
          status: "denied",
          error:
            "授权账号与发起任务的飞书账号不一致，请使用自己的账号重新授权。",
          device_code: undefined,
          pending_tokens: undefined,
        });
        return;
      }
      if (store.get("connection_logins", id)?.status !== "pending") return;
      const connection = {
        id: key(bot.app_id, user.open_id),
        bot_id: bot.id,
        app_id: bot.app_id,
        subject_id: user.open_id,
        name: user.name || user.en_name || user.open_id,
        ...tokens,
        status: "connected",
        generation: randomUUID(),
      };
      store.transaction(() => {
        store.put("user_connections", connection);
        if (row.owner.kind === "local")
          store.put("connection_bindings", {
            id: key("local", bot.app_id),
            connection_id: connection.id,
          });
        store.put("connection_logins", {
          ...row,
          status: hasScopes(connection, row.requirement)
            ? "connected"
            : "insufficient_scope",
          error: hasScopes(connection, row.requirement)
            ? undefined
            : "已登录，但未授予任务所需权限，请检查应用权限并重新授权。",
          connection_id: connection.id,
          device_code: undefined,
          pending_tokens: undefined,
        });
      });
    });
  return {
    begin,
    async prepare(row) {
      const requirement = row.connection_requirement;
      if (!requirement) return row;
      if (row.connection_dispatch_pending) return row;
      if (row.connection) {
        const current = store.get("user_connections", row.connection.id);
        if (
          row.connection.expires_at <= Date.now() ||
          current?.generation !== row.connection.generation ||
          current.status !== "connected"
        )
          throw new AppError(
            428,
            "此会话的飞书连接已失效，请开启新会话。",
            "connection_expired",
          );
        return row;
      }
      const owner = row.connection_owner;
      let connection = selected(requirement, owner);
      if (
        connection?.status === "connected" &&
        hasScopes(connection, requirement)
      )
        connection = await refresh(connection, app(requirement));
      if (
        !connection ||
        connection.status !== "connected" ||
        !hasScopes(connection, requirement) ||
        connection.expires_at <= Date.now() + 60000
      ) {
        const previous =
          row.connection_wait &&
          store.get("connection_logins", row.connection_wait.id);
        // Terminal authorizations need an explicit retry, never repeated consent loops.
        const login =
          previous && previous.status !== "connected"
            ? safeLogin(previous)
            : await begin(requirement, owner);
        return { ...row, connection_wait: login };
      }
      const bot = app(requirement);
      return {
        ...row,
        connection_wait: undefined,
        configuration: {
          ...row.configuration,
          connection: {
            service: "feishu",
            name: connection.name,
            expires_at: connection.expires_at,
          },
        },
        connection: {
          id: connection.id,
          name: connection.name,
          subject_id: connection.subject_id,
          generation: connection.generation,
          expires_at: connection.expires_at,
        },
        request: {
          ...row.request,
          environment: {
            ...row.request.environment,
            env: {
              ...row.request.environment.env,
              LARKSUITE_CLI_APP_ID: bot.app_id,
              LARKSUITE_CLI_BRAND: bot.brand === "lark" ? "lark" : "feishu",
              LARKSUITE_CLI_USER_ACCESS_TOKEN: connection.access_token,
              LARKSUITE_CLI_DEFAULT_AS: "user",
              LARKSUITE_CLI_STRICT_MODE: "user",
            },
          },
        },
      };
    },
    async tick() {
      for (const row of store
        .list("user_connections")
        .filter((r) => r.revocation_pending)) {
        try {
          await revoke(row);
        } catch {
          /* Retry provider revocation without restoring local access. */
        }
      }
      for (const row of store
        .list("connection_logins")
        .filter((r) => r.status === "pending")) {
        try {
          await poll(row.id);
        } catch {
          /* Keep the durable request for a later poll. */
        }
      }
    },
    async api(method, path, body) {
      if (path === "/app/connections" && method === "GET")
        return store
          .list("feishu_bots")
          .filter((b) => b.app_id && b.app_secret)
          .map((bot) => {
            const requirement = {
              service: "feishu",
              bot_id: bot.id,
              app_id: bot.app_id,
            };
            return {
              service: "feishu",
              bot_id: bot.id,
              app_id: bot.app_id,
              name: bot.name,
              required_scopes: [
                ...new Set(
                  store
                    .list("agents")
                    .filter((a) => a.connection_requirement?.bot_id === bot.id)
                    .flatMap((a) => scopesOf(a.connection_requirement.scopes)),
                ),
              ].join(" "),
              connection: safeConnection(
                selected(requirement, { kind: "local" }),
              ),
              login: safeLogin(
                store
                  .list("connection_logins")
                  .find(
                    (r) =>
                      r.owner.kind === "local" &&
                      r.requirement.app_id === bot.app_id,
                  ),
              ),
            };
          });
      const id = path.match(
        /^\/app\/connections\/feishu\/([a-f0-9-]{36})$/,
      )?.[1];
      if (!id || !uuid.test(id)) throw new AppError(404, "Not found.");
      const requirement = connectionRequirement(store, {
        service: "feishu",
        bot_id: id,
        scopes: body?.scopes || "contact:user.base:readonly",
      });
      if (method === "POST") return begin(requirement, { kind: "local" }, true);
      if (method !== "DELETE") throw new AppError(405, "Method not allowed.");
      const row = selected(requirement, { kind: "local" });
      if (row)
        store.put("user_connections", {
          ...row,
          status: "disconnected",
          generation: randomUUID(),
          revocation_pending: true,
        });
      for (const login of store
        .list("connection_logins")
        .filter(
          (r) =>
            r.owner.kind === "local" &&
            r.requirement.app_id === requirement.app_id &&
            r.status === "pending",
        ))
        store.put("connection_logins", {
          ...login,
          status: "cancelled",
          device_code: undefined,
        });
      for (const session of store
        .list("sessions")
        .filter(
          (r) =>
            r.connection_owner?.kind === "local" &&
            r.connection_requirement?.app_id === requirement.app_id &&
            r.connection_wait &&
            !r.core_session_id,
        ))
        store.put("sessions", {
          ...session,
          connection_wait: { ...session.connection_wait, status: "cancelled" },
        });
      if (row) {
        try {
          await revoke(row);
        } catch {
          /* Background polling retries revocation. */
        }
      }
      return { disconnected: true };
    },
  };
}

export function guardConnectionInput(store, path, body) {
  const id = path.match(
    /^\/v1\/agents\/sessions\/([a-f0-9-]{36})\/events$/,
  )?.[1];
  if (
    !id ||
    !body?.events?.some((e) => e.type !== "agent.session.input.cancel")
  )
    return;
  const row = store.list("sessions").find((r) => r.core_session_id === id);
  if (!row?.connection) return;
  const connection = store.get("user_connections", row.connection.id);
  if (
    row.connection.expires_at <= Date.now() ||
    connection?.generation !== row.connection.generation ||
    connection.status !== "connected"
  )
    throw new AppError(
      428,
      "此会话的飞书连接已失效，请开启新会话。",
      "connection_expired",
    );
}
