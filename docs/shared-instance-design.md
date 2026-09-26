# DeepSeek 接入 WebMCP App（共享运行环境）设计

状态：2026-09-26 起草，所有者明天验收。代码在隔离 worktree，**未提交、未安装**。

## 目标（所有者原话，2026-09-26）

- 不要临时方案：DeepSeek 也由 WebMCP App 管理权限。
- DeepSeek 要能挂多个文件夹，每个文件夹单独控制能否写入（和 ChatGPT 那套一样）。
- WebMCP App 要显示“正在接入的是谁”，以后还可能接本地模型。

## 为什么不给 DeepSeek 另做一份“多文件夹”

`webmcp-bridge/docs/development-roadmap.md` §O（所有者确认的总体架构）规定：Browser Control、Local Workspace、**Multi-Mount**、High Trust、Remote Host Access 由所有 Provider 共用，**不为某个 Provider 重新实现**。

共享运行环境（webmcp-runtime / Bridge）已经具备所需能力，下面这些都已核实：

| 事实 | 位置 |
|---|---|
| 每个 **Instance** 可以挂多个 Folder，每个 Folder 单独 Write ON/OFF，内核级 RW/RO bind | roadmap §M；`native/deploy/workspace-mount-config.js`、`container-policy.js` |
| DeepSeek 钉住的运行环境 `32df7fb`（webmcp-runtime v0.2.0）已包含 Multi-Mount | `git grep workspace-mounts 32df7fb` |
| 本机共享运行环境里已经有 `deepseek` 实例（`~/.config/webmcp/instances/deepseek/workspace.json`） | 实机只读核对 |
| WebMCP App 菜单通用地列出所有实例（`instance-list` 读 `~/.config/webmcp/instances/*`），所以 `deepseek` **现在就在菜单里**，显示名是原始的 “deepseek” | Bridge `installer.js` `mountedFolderInstancesWebMcp`；`main.swift` `instanceDisplayName` |
| DeepSeek 的 Host Access（High Trust）**已经**走共享运行环境的 `deepseek` 实例 | `native/host/host-access.js` |
| DeepSeek 的普通文件工具（open_workspace/read/write/edit/bash）**没有**走实例：本地程序每次调用自己 `docker run` 一个新容器，读自己的 `~/.deepseek-webmcp` 配置和 Full Access 租约 | `native/host/docker-dispatch.js` |

所以在 App 里给 `deepseek` 实例加文件夹、开 Full Access，对 DeepSeek 的文件工具**不起作用**。这就是 2026-09-26 所有者遇到的“权限对不上”的根因之一。另一个原因是面板里的 ChatGPT 网页方案也走 DeepSeek 的本地程序。

结论：所有者说的第一步“让 DeepSeek 支持多文件夹”，做法是**让 DeepSeek 的文件工具改走共享运行环境里的 `deepseek` 实例**。多文件夹、每个文件夹的写入开关、Full Working Access、Host Access 都直接复用，并且由 WebMCP App 统一管理。

## 目标结构

```text
Side Panel（DeepSeek / ChatGPT 网页）
   └─ Chrome Native Messaging → DeepSeek 本地程序 chrome-host.js
        ├─ 文件工具  → 共享运行环境 start.js（WEBMCP_INSTANCE_ID=deepseek）→ docker exec → 实例容器（多文件夹挂载）
        ├─ host_command → 共享运行环境 host-command（已是这样）
        └─ 状态查询 → 实例的文件夹列表 / Full Working Access / Host Access（只读），撤销走实例的撤销
WebMCP App（菜单栏）
   └─ Instance → Folder → Write、Full Working Access、Host Access（已有，通用）
      + 显示名和“接入的是谁”（本次新增，只加标签）
```

## 分片（每片可独立审查）

| 片 | 内容 | 仓库 | 今晚状态 |
|---|---|---|---|
| S1 | DeepSeek 文件工具改走 `deepseek` 实例的 `start.js` 中转；复用现有 `mapContainerResponse` | deepseek-webmcp | 实现 + 隔离测试 |
| S2 | 状态与撤销改读实例：面板 Access 行显示实例的文件夹列表（每个 WRITE/READ）、Full Working Access、Host Access；Revoke 走实例 | deepseek-webmcp | 实现 + 测试 |
| S3 | WebMCP App 显示名：`default` → “ChatGPT (MCP)”，`deepseek` → “Web Provider（DeepSeek · ChatGPT 网页）”，`prism` → “Prism”；菜单顶部写明每个实例接入的是谁 | webmcp-bridge | 实现 + Swift 自测 |
| S4 | 安装与迁移：开通 `deepseek` 实例（镜像钉、容器），把 `~/.deepseek-webmcp` 的文件夹写进实例的 `workspace-mounts.json`（可写），可回滚 | deepseek-webmcp | 代码 + 测试，**不在本机执行** |
| S5 | 面板 Settings 里的 Folder / Full Access / High Trust 入口去掉（计划 U2），只留显示和 Revoke | deepseek-webmcp | S1–S4 验收后再做 |

## 需要所有者确认的产品决定（先按默认值做）

1. **面板里 ChatGPT 网页方案用哪个实例。** 它和 DeepSeek 共用本地程序。默认：两者共用 `deepseek` 实例，App 里这个实例显示为 “Web Provider（DeepSeek · ChatGPT 网页）”，这样授权不会再“看起来给了 ChatGPT、实际给了别人”。备选：以后为 ChatGPT 网页单独建 `chatgpt-web` 实例（本地程序需要知道当前是哪个 Provider，改动更大）。
2. **App 里“接入的是谁”怎么判断。** 默认：静态标签，按实例写明对应的 Provider。备选：显示最近一次工具调用来自哪个 Provider、什么时间（需要实例记录心跳，今晚不做）。
3. **“为以后接本地模型做准备”。** 默认：只把显示名做成一个表，新增 Provider 时加一行；不做插件系统。
4. **DeepSeek 旧的 `~/.deepseek-webmcp/full-access.json` 租约。** 默认：迁移后不再使用，由实例的 Full Working Access 取代；迁移时如果旧租约还有效，就当作过期处理，不自动带过去。

5. **Windows（WSL）怎么办。** 共享运行环境的实例控制器和 WebMCP App 只在 macOS 上有。默认：**只有 macOS 改走实例**；WSL 上的文件工具、状态和 Full Access 保持原来的一次性 docker 容器，不受这次改动影响。备选：以后共享运行环境支持 WSL 实例时再统一。

## 不做

- 不在本机安装、迁移、开通实例，也不改任何在用的 Docker 镜像或容器。安装步骤写给所有者，由所有者决定何时执行。
- 不提交、不推送：两个仓库的 AGENTS.md 都要求所有者明确要求后才提交。
- 不动 P1 发布集、`release-set-p1`、Bridge 主仓库里别人没提交的改动。
- 不做通用插件系统。

## 风险

- **Docker 镜像标签：** 移动标签会删掉旧镜像，以前弄坏过所有者在用的 DeepSeek。S4 开通实例时必须使用 guard tag。今晚不跑任何构建镜像的命令，Bridge 只跑 lint 和单元测试，不跑 `npm run build`。
- **速度：** 每次调用都要启动一次 `start.js`，它会检查镜像钉和容器状态，再 `docker exec`。原来每次是 `docker run` 一个新容器，预计不会更慢，要实测。
- **超时和说明文字不同：** DeepSeek 自己的启动脚本把 bash 限制在 30 秒，并给模型一段 DeepSeek 专用的说明。共享运行环境用的是它自己的默认值，需要确认 bash 超时上限。
- **DeepSeek 不用 Full Working Access（所有者决定，2026-09-26）：** 只用两种权限：挂载文件夹（每个文件夹单独 Write）和 Host Access。原因：Full Working Access 让容器看到整个 home，而运行环境的保护清单不含 `~/deepseek-webmcp`（本地程序）和 `~/.nvm`（node），模型可以改写之后在本机执行的代码（独立审查 R1）。不用这一级，问题就不存在，也不需要搬目录或改运行环境。所有者随后把这条定为所有 Provider 的规则：WebMCP App 菜单不再提供 Full Working Access（Bridge worktree B 已删除授予入口，已有租约仍显示并可撤销）；运行环境后端的 `elevate` / `access-grant` 和 docker-full 租约以后随运行环境新版本删除。
- **两个运行环境版本写同一个实例：** WebMCP App 用 `current`（本机 `ca3a3c2`）的控制器改 `deepseek` 实例，DeepSeek 用钉住的 `32df7fb`。两版配置格式相同（`workspace-mounts.json` 同样的键和版本），但 `32df7fb` 对文件夹检查更严：拒绝包含整个 home 的文件夹、拒绝与受保护路径重叠的文件夹。用旧 App 加进去的这类文件夹，DeepSeek 这边可能起不了容器。另外两版的保护路径清单不同，而保护路径计入容器策略摘要：一方开的 home 级授权容器，另一方会判为策略不符（失败时是拒绝，不是放行）。所以实机验收（E7）前必须让 App 和 DeepSeek 用同一版本（App 升级到 `32df7fb` 或以后）。
- **Host Access 的授权入口（S5 前）：** Settings 里的 Host Access 授权仍在，现在改为沿用实例已有的文件夹配置，只在实例还没有配置时才写入 DeepSeek 的文件夹，不会覆盖 App 设的文件夹。Settings 里的 Full Access 授权（DeepSeek 自己的旧租约）在 macOS 上已经不起作用，S5 删掉；S5 必须在安装前完成。
- **工作区路径变化：** 多文件夹时，文件夹挂在 `/workspace/mounts/<id>` 下面，模型看到的路径会变。工具说明里 “/workspace is the owner's folder” 这句要跟着改。
