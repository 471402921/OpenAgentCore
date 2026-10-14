import { posix } from "node:path";
import { AppError, text } from "./store.mjs";

export function runtimeProfile(body) {
  if (!["openai_hosted", "none", "self_hosted"].includes(body.environment))
    throw new AppError(400, "运行环境无效。");
  if (body.environment !== "self_hosted")
    return { environment: body.environment };
  if (!["linux", "macos", "windows"].includes(body.platform))
    throw new AppError(400, "请选择机器平台。");
  const directory = (value) => {
    const result = text(value, "工作目录", 4096, true);
    const portable = result.replaceAll("\\", "/");
    const clean = (path) =>
      posix.normalize(path) === path && (path === "/" || !path.endsWith("/"));
    const windows = body.platform === "windows";
    const drive = /^[A-Za-z]:\//.test(portable);
    const unc = portable.startsWith("//");
    const valid = windows
      ? !/[:*?"<>|]/.test(drive ? portable.slice(2) : portable) &&
        (drive
          ? clean(portable.slice(2))
          : unc &&
            portable.slice(2).split("/").length >= 2 &&
            portable
              .slice(2)
              .split("/")
              .every((part) => part && part !== "." && part !== ".."))
      : result.startsWith("/") &&
        !unc &&
        !result.includes("\\") &&
        clean(result);
    if (
      !valid ||
      /[\x00-\x1f\x7f]/.test(result) ||
      Buffer.byteLength(result) > 4096
    )
      throw new AppError(
        400,
        "请填写规范的绝对目录，不使用重复分隔符、末尾斜杠、. 或 ..。",
      );
    return result;
  };
  if (
    body.capability_directories !== undefined &&
    (!Array.isArray(body.capability_directories) ||
      body.capability_directories.length > 8)
  )
    throw new AppError(400, "能力目录最多 8 个。");
  const directories = (body.capability_directories || []).map(directory);
  if (new Set(directories).size !== directories.length)
    throw new AppError(400, "能力目录不能重复。");
  return {
    environment: "self_hosted",
    platform: body.platform,
    workspace_directory: directory(body.workspace_directory),
    capability_directories: directories,
  };
}
