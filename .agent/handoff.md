# Handoff — DeepSeek 接入 WebMCP App（共享运行环境）

## Completed
- 2026-09-26：web-provider 分支 lean-check 修复已提交（0e190e1..dff7ea9，334/334）。
- 设计文档 docs/shared-instance-design.md（本 worktree，未提交）。
- 事实核实：runtime 32df7fb 含 Multi-Mount；本机 deepseek 实例存在且已出现在 App 菜单；DeepSeek 文件工具仍走自有 docker run。

## Current State
- S1 完成（未提交）：native/host/instance-dispatch.js + tests/instance-dispatch.test.js；chrome-host.js 走实例；tests/native-host-e2e.test.js 改为临时 HOME + 假固定版本 start.js（无生产后门）。npm run check 338/338。
- S2 完成（未提交）：native/host/instance-access.js（经钉住版本的 local-instance-controller.js mount-list / access-status / access-revoke --instance deepseek，与 App 同一组命令）；control.js status/stop-* 在 macOS 走实例；host_command 门禁改按实例自己的 workspace.json 判定租约，grantHostAccess 不再覆盖实例已有文件夹；hostAccessStatus/revokeHostAccess 已删；面板 Access 行按文件夹显示 WRITE/READ，无法核实的租约显示 ACCESS UNVERIFIED。tests/fixtures/pinned-release.js 为共用假固定版本。审查后修正：文件夹读取失败不再隐藏租约和 Revoke（allSettled）；撤销后只读一次状态；平台分流移到 instance-dispatch.js dispatchToolRequest（可注入 kind，有测试），e2e 在非 macOS 跳过。npm run check 348/348。
- S3 完成（未提交，worktree B）：main.swift 显示名改为一张表，deepseek → “Web Provider (DeepSeek · ChatGPT web)”；default 保持 “ChatGPT Side Panel”（路线图 §O 即 MCP Mode 面板）。npm run test:menubar PASS，lint 通过；未跑 npm run build。
- S4 完成（未提交，未在本机执行）：native/host/instance-migration.js（planInstanceMigration 预检：租约存在/实例只有文件夹没有 workspace.json/运行环境拒绝的文件夹 → 在任何写入和镜像标签移动前停止；migrateToInstance：没有实例就用 DeepSeek 自己的镜像钉 provision，legacy 实例先带上原文件夹及其写开关，再加 DeepSeek 文件夹并开 Write；已有的文件夹不动，重跑零改动）；install-rollback.js 新增 trackContainer（回滚时 docker rm --force 实例容器）；安装器 macOS 上预检在 beginInstall 前，迁移在 runtime.pin() 后，instanceFiles 加 workspace.json / workspace-mounts.json / attachment-generation.json。npm run check 356/356。
- 独立审查（2026-09-26，只读子 agent）已处理：R4a 撤销在 Docker 不可用时回退为直接清租约（host-access.clearInstanceLease）；R4b 控制器不答时直接读租约文件（instanceLeaseStatus）；R4c 任一授权开启时 Access 行显示 Home（运行环境 start.js 对任一租约都用 home 级容器）；R5 迁移先删实例容器（镜像重建后旧容器会被判不符）。npm run check 通过。
- 审查 R1 已由所有者决定消解：DeepSeek 只用挂载文件夹 + Host Access，不用 Full Working Access（不搬目录、不复制 node、不改运行环境；S5 删 Settings 的 Full Access 入口）。所有者把它定为所有 Provider 的规则：App 菜单已删除 Full Working Access 授予入口（worktree B：授予入口、Full Working Access 的显示和停止全部删除；只留通用的 “Revoke Access Lease” 用于无法核实级别的租约（Host Access 也会出现）；本机核实当时无任何租约文件；README / installation / usage / read-only-acceptance 已同步；test:menubar PASS，lint 通过）。下一步（安装前做）：webmcp-runtime 删除 elevate / access-grant 与 docker-full 租约，发一个新版本；DeepSeek 钉到它，App 的 current 也升到它（同时解决 App/DeepSeek 版本不一致 R7）；DeepSeek 面板和 Settings 去掉 FULL ACCESS。发布新版本需所有者批准。
- 审查未处理的非阻断项：attachment-generation 回滚后数值变小（问题）；workspaceId 跨授权切换不变（问题）；超时 SIGKILL start.js 会留下 docker exec；边界错误文字含本机路径；安装器调用顺序和真实固定版本契约没有测试（只能实机）。
- 平台分流：macOS 走实例；WSL 仍走旧 docker run（dispatchNativeRequest / loadNativeHostConfig 保留给 WSL）。S5 只删 macOS 上的旧入口，不删 WSL 路径。设计文档决定 #5 待所有者确认。
- scripts/doctor.mjs 仍检查旧 docker 路径（macOS 上已不是实际路径）——S5 改为检查实例。
- Settings（settings-ui.js）仍显示 DeepSeek 自己的文件夹和旧 Full Access 授权——S5 处理，且 S5 必须在安装前完成。
- worktree A：~/Doc/deepseek-webmcp-work/shared-instance（branch feat/shared-instance-workspace，基于 dff7ea9）——S1/S2/S4。
- worktree B：~/Doc/webmcp-bridge-work/instance-labels（branch chatgpt/instance-provider-labels，基于 7e2372f）——S3。
- 两个仓库都不提交（AGENTS.md 规定需所有者明确要求）。

## Next Steps
- S4 install/migration code → 独立 subagent 审查 → 交付说明。

## Key Decisions
- 复用共享运行环境的 deepseek 实例，而不是给 DeepSeek 另做多文件夹（roadmap §O）。
- 不在本机安装/迁移/开通；Bridge 不跑 npm run build（会动 Docker 镜像）。
- 产品决定默认值见设计文档“需要所有者确认的产品决定”。
