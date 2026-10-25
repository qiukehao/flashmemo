# 闪记 FlashMemo

[![CI](https://github.com/qiukehao/flashmemo/actions/workflows/ci.yml/badge.svg)](https://github.com/qiukehao/flashmemo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue.svg)](https://github.com/qiukehao/flashmemo)
[![Built with Tauri 2](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB.svg)](https://v2.tauri.app/)
[![Tests](https://img.shields.io/badge/tests-204%20Rust%20%2B%20307%20front-passing-3fb950.svg)](#测试)

**常驻 Windows 托盘的闪卡复习工具**：把 Markdown 笔记变成卡片，到点自动弹窗考你，按「隔 N 张」的间隔重复节奏帮你把东西真正背下来。

核心功能**零网络、数据纯本地**——导入、调度、复习、存储全程不发任何请求，卡片数据不出 `%APPDATA%\FlashMemo`。没有账号，没有遥测，没有崩溃上报。

## 为什么不是又一个 Anki

间隔重复的原理人人都懂，缺的是「**在正确的时间被考一次**」的执行力：

- 它**长在桌面上**：常驻托盘不占地方，到点弹出小窗，考完即走——复习八股的人一天十几个小时都在电脑前，工具就该在这里；
- 间隔用「**中间还要过几张卡**」计，而不是「隔几天」：冲刺期一天见十次，休假两周自动断联，节奏跟着内容密度走，不会被日期追债；
- 每次评分**立刻落库**，崩溃断电不丢进度；弹窗里还能**直接改卡面**，不用切应用。

## 界面

| 首页 | 卡包 |
| --- | --- |
| ![首页](img/home.png) | ![卡包](img/decks.png) |

| 复习弹窗 | 设置 |
| --- | --- |
| ![复习弹窗](img/popup.png) | ![设置](img/settings.png) |

![仪表盘](img/dashboard.png)

## 调度：按「隔 N 张」间隔重复

每次展示卡片时全局计数器 +1，评分决定这张卡「下次隔几张再出现」：

| 评分 | 间隔 | 等级变化 |
| --- | --- | --- |
| 不了解 | 隔 3 张（连续 3 次标记 ⚠ 重点卡，隔 5 张回访；第 4 次起退避到 10 张） | 高等级卡回落 |
| 熟悉 | 至少隔 8 张 | 4 级以上视为遗忘，降 1 级 |
| 可以讲出来 | 至少隔 20 张 | 升 1 级，间距按新等级走 |

- 等级 0→5 的基础距离是 **3 / 5 / 10 / 20 / 50 / 100 张**，每天最多升 1 级（当天连答对不算长期记忆）；
- **时间下限保护**：不了解 10 分钟 / 熟悉 30 分钟 / 讲出 2 小时内绝不重现——「隔几张」很快时也不会连着轰炸同一张卡；
- **闭环**：连续 3 次讲出且跨 3 个学习日自动归档（相邻卡未掌握则暂缓）；归档卡按「离上次多久」加权抽查回访，防止背完就忘；
- 间隔带 ±20% 抖动，固定顺序背不出答案。

## 功能一览

- **导入**：`#` 卡包 / `##` 章节 / `###` 卡片的三级 Markdown；粘贴一段文本一次成多卡；幂等更新不丢进度；截图自动搬进本地附件
- **复习弹窗**：题面折叠展开、卡面即编辑器（右键批注 / 高亮 / 备注 / 表格 / 撤销栈）、知识铺垫前置卡、顺链续复习、字号行距段距可调、快捷键全键盘流
- **管住自己**：连续 3 次「不了解」标 ⚠ 专项理解；「无法关闭模式」复习完这批卡前没有退出入口；弹窗被拖到副屏放置不管会被拉回并记一次逃避
- **智能节奏**：今日目标（复习张数 / 讲出张数）时段内自动排程；屏幕监控识别到娱乐应用时间隔减半、学习应用间隔翻倍并延后到切换间隙
- **AI 助手**：卡面划选一键把问题送进 DeepSeek / ChatGPT 等网页（应用本身依旧零联网）；对话与登录态持久保留
- **组卷复习**：跨卡包自由抽卷（最弱优先 / 随机）、保存预设；仪表盘有 7 天趋势、热力图与熟练度分布
- **管住打扰**：开机自启、全屏免打扰（游戏/视频时自动降级为轻提醒）、提醒方式三档（强制弹窗 / 仅轻提醒 / 先提醒未处理再弹窗）
- **数据自由**：Markdown 导出与导入格式互逆；明暗主题跟随系统或手动锁定；空库自带示例卡包一键体验

完整规格见 [SPEC.md](./SPEC.md)。

## 快速开始

环境要求：Node.js 18+、Rust stable（MSVC 工具链）、Windows 10/11（WebView2 运行时系统自带）。

```bash
git clone https://github.com/qiukehao/flashmemo.git
cd flashmemo
npm install
npm run tauri dev      # 完整应用（热重载）
```

出安装包（NSIS）：

```bash
npm run tauri build    # 产物在 src-tauri/target/release/bundle/
```

### 浏览器调试模式

前端不依赖 Tauri 也能跑：`npm run dev` 后打开

- `http://localhost:1420/` — 主窗口界面
- `http://localhost:1420/?window=popup` — 复习弹窗界面

此时 `src/lib/mockBackend.ts` 会用内存 + localStorage 的假数据接管全部命令，可以直接用 DevTools 走完整个复习流程，不必等 Rust 编译。

## 导入格式

````markdown
# MySQL

## 事务

### ACID 是什么？
- **原子性**：不可分割
- **一致性**：从一个一致状态到另一个一致状态

### 隔离级别有哪些？
1. 读未提交
2. 读已提交
````

- `###` 之后的内容是卡片背面（答案）；`####` 及更深保留在卡面正文里。
- 长题干 / 图片题：用 `> [!question]` 标注块写题面，其余写答案。
- 章节里一个 `###` 都没有时，整段会成为**一张题面卡**（正面是全文、背面留空）。
- 导入是**幂等**的：以 `(卡包名, 章节名, 卡片标题)` 为唯一键更新，复习进度保留；在应用里改过的卡片默认保留本地版本。

完整规则见 [SPEC.md](./SPEC.md) §5。

## 数据与隐私

- 所有数据在 `%APPDATA%\FlashMemo`：`data.db`（SQLite 单文件）、`attachments/`（卡面图片，内容哈希去重）、`backups/`（每日自动备份，保留 7 份）、`logs/`（运行日志，保留 7 天）。
- 导入/调度/复习/存储**零网络请求**；卡面里的远程图片一律不加载；没有遥测与崩溃上报。详见 [PRIVACY.md](./PRIVACY.md)。

## 项目结构

```
src/                  React 18 + TypeScript(strict) 前端
  pages/              首页 / 卡包 / 导入 / 添加卡片 / 疑难卡 / 设置
  components/         复习弹窗、组卷、批注菜单、AI 窗口等
  lib/                Tauri invoke 封装、Markdown 渲染、浏览器 mock 后端
src-tauri/src/        Rust 后端
  parser.rs           Markdown → 卡包/章节/卡片（纯函数）
  scheduler.rs        「隔 N 张」调度（纯逻辑）
  goal.rs             今日目标节奏控制器（纯函数）
  engine.rs           15s tick 弹窗引擎（决策是纯函数）
  db.rs               SQLite 连接、迁移、DAO
  commands.rs         Tauri command 层（薄壳：校验 + 委托）
SPEC.md               产品与技术规格（唯一需求来源）
```

## 测试

```bash
cargo test                                  # Rust：解析、调度、目标、引擎、数据库（在 src-tauri/ 下执行）
npm test                                    # 前端：解析镜像、编辑器往返、页面交互
cargo clippy --all-targets -- -D warnings   # Rust lint
npx tsc --noEmit                            # TypeScript 类型检查
```

## 路线图

- [x] 开机自启 · 全屏免打扰 · 组合提醒 · Markdown 导出 · 明暗主题 · 首启示例卡包（2026-10）
- [ ] 托盘角标显示到期数
- [ ] Anki（apkg）导入

欢迎 issue 提需求、PR 提实现。

## 许可

[MIT](./LICENSE)
