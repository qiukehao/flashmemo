# AGENTS.md — 闪记 FlashMemo

> 给 AI 编码助手与人类协作者的工作指南。**动手前必读 [SPEC.md](./SPEC.md)**——它是唯一的需求来源；本文件只讲"怎么干活"。

## 项目是什么

「闪记 FlashMemo」：常驻 Windows 托盘的闪卡复习工具——Markdown 导入八股文笔记，定时弹窗 + FSRS 间隔重复调度。目标是低占用、核心功能零网络、数据纯本地。本项目将开源。

## 技术栈

- 应用框架：Tauri 2（Rust 后端 + 系统 WebView2 前端容器）
- 前端：React 18 + TypeScript（strict）+ Vite
- 后端：Rust stable（MSVC）+ rusqlite + fsrs-rs
- 测试：cargo test（Rust 核心）+ Vitest（前端逻辑）

## 目录结构

```
shanka_study/
├── SPEC.md            # 产品与技术规格（唯一需求来源）
├── AGENTS.md          # 本文件
├── src/               # React 前端
│   ├── pages/         # 仪表盘 / 卡包管理 / 导入 / 卡片编辑 / 设置
│   ├── components/    # 复习弹窗等共享组件
│   └── lib/           # Tauri invoke 封装与共享类型
├── src-tauri/         # Rust 后端
│   └── src/
│       ├── parser.rs      # Markdown → 卡包/章节/卡片（纯函数，重点测试）
│       ├── scheduler.rs   # FSRS + 分钟级学习步骤（纯逻辑，重点测试）
│       ├── db.rs          # SQLite 连接、迁移、DAO
│       ├── commands/      # Tauri command 层（薄壳：校验 + 委托）
│       └── engine.rs      # 15s tick 触发引擎
└── docs/plans/        # 实施计划文档
```

## 开发命令

```bash
npm run tauri dev      # 完整应用（热重载）
npm run dev            # 仅前端 → 浏览器调试模式（见下）
cargo test             # Rust 核心测试（在 src-tauri/ 下执行）
npm test               # 前端逻辑测试
npm run tauri build    # 出安装包
```

### 浏览器调试模式（mock 后端）

`npm run dev` 启动 Vite 后，用浏览器打开：

- `http://localhost:1420/` — 主窗口界面
- `http://localhost:1420/?window=popup` — 复习弹窗界面

浏览器里没有 Tauri 环境，`src/lib/mockBackend.ts` 会用内存假数据接管全部命令
（4 张示例卡、设置、评分等），可直接用 DevTools 元素选择器定位问题、
用 Console 看状态更新——**报 bug 时附上元素选择器和截图即可**。
该模块是动态导入的，只在非 Tauri 环境加载，不影响正式包体积。

浏览器没有附件目录，卡面上的 `attachment:` 图片本会全部渲染成「图片未找到」细条，
图片布局（缩放 / 折叠 / 间距）就没法在调试模式里复现。因此 mock 会给每个还没注册过的
图片引用补一张 **16:9 的占位 SVG**（写着文件名，一眼看得出是替身）——尺寸与真实截图同量级，
布局是真的，只是内容不是。排查图片排版用它。

## 工程规范

1. **TDD**：新功能先写失败的测试再写实现；`parser.rs` 与 `scheduler.rs` 的任何行为变更必须有对应单元测试。
2. **Rust**：`cargo clippy -- -D warnings` 与 `cargo fmt --check` 通过才算完成。
3. **TypeScript**：strict 模式；`tsc` 零报错才算完成。
4. **语言**：UI 文案一律中文；代码标识符与注释用英文；注释只写代码本身表达不了的约束与原因。
5. **架构红线**：
   - Rust command 层保持薄壳，业务逻辑放可独立测试的纯 Rust 模块；
   - 前端不直接碰数据库，一切经 Tauri invoke；
   - 记忆状态计算只走 fsrs-rs 公开 API，不自研调度公式。
6. **行为不变式**（改动必须保持，依据 SPEC §8 / §13 / §17）：
   - 单实例运行，二次启动唤起既有实例的主窗口；
   - 全局同时最多一个复习弹窗会话；
   - 每次评分立即落库（崩溃/断电不丢评分）；
   - 主窗口关闭 = 隐藏到托盘，不退出进程；托盘菜单「退出」才结束进程；
   - 弹窗位置避开任务栏工作区，默认不抢键盘焦点。
7. **隐私红线**：导入/调度/复习/存储零网络请求；用户数据不出 `%APPDATA%\FlashMemo`；不引入任何遥测、崩溃上报。

## 提交与开源约定

- git 初始化后使用 Conventional Commits（`feat:` / `fix:` / `test:` / `docs:`…），描述用中文；
- 不提交：密钥、个人绝对路径、`node_modules/`、`src-tauri/target/`、`*.db`；
- 面向开源：代码中不写内部信息；README 与 LICENSE（拟 MIT）在 M3 里程碑前补齐。

## 给 Agent 的提醒

- 需求问题查 SPEC.md；找不到答案就问人，不要自行发明功能；
- 改评分/调度行为前，先对照 SPEC §7 与文末「评分按钮行为速查表」；
- 里程碑与优先级见 SPEC §18 / §4：M1 只做核心闭环，别提前实现 P1/P2 功能；
- 完成的定义 = 代码 + 测试 + lint 全绿，缺一不算完成。
