# Eval — DeepSeek 接入 WebMCP App

| # | 验收条件 | 验证方式 | 状态 |
|---|---|---|---|
| E1 | DeepSeek 文件工具经 start.js（WEBMCP_INSTANCE_ID=deepseek）执行，不再 docker run | 单元测试：spawn 参数与环境变量、响应映射、超时/超大响应 | PASS（instance-dispatch 4/4 + native-host-e2e 3/3，check 338/338） |
| E2 | workspaceId 在多次调用之间稳定 | 单元测试：同一实例同一令牌 | PASS（instanceRuntimeToken 稳定性测试） |
| E3 | 面板 Access 行显示实例文件夹（WRITE/READ）、Full Working Access、Host Access | 单元测试 accessParts | PASS（panel-header + instance-access 映射测试，check 345/345） |
| E4 | Revoke 撤销实例的 Full Working Access / Host Access | 单元测试 | PASS（instance-access：两个 stop 控制都跑 access-revoke --instance deepseek；控制器失败时报错） |
| E5 | App 菜单显示实例对应的 Provider | Swift 自测 + 编译 | PASS（test:menubar PASS；instanceDisplayName 表 + 自测 3 条） |
| E6 | 迁移：旧文件夹写入实例 workspace-mounts.json（可写），失败可回滚，不碰在用镜像 | 单元测试（临时 HOME） | PASS（instance-migration 6 条：新实例/legacy 异目录/legacy 同目录/重跑零改动/预检拒绝/中途失败；install-rollback 容器 2 条） |
| E7 | 本机实机验收（所有者执行安装后） | 所有者 | 待所有者 |
| E9 | S5 在安装前完成（删 Settings 的旧 Full Access / 文件夹入口，doctor 改查实例，uninstall 删 deepseek 实例容器） | 代码审查 | TODO |
| E10 | 审查 R1 | 所有者决定：DeepSeek 不用 Full Working Access（只用挂载文件夹 + Host Access） | 已消解 |
| E11 | App 与 DeepSeek 运行环境版本一致（审查 R7） | 实机核对 | 待所有者 |
| E8 | 所有检查通过；独立审查无未处理阻断项 | npm run check / 审查报告 | TODO |
