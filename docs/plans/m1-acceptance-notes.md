# M1 验收走查记录（2026-09-28）

## 自动化验证（已完成）

| 项目 | 结果 |
|---|---|
| Rust 单元测试（parser/db/import/scheduler/services/engine） | 43 passed |
| 前端测试（formatInterval / 键盘映射 / 冒烟） | 5 passed |
| cargo clippy --all-targets | 0 warning |
| cargo fmt --check / tsc --noEmit / vite build | 全部通过 |
| `tauri dev` 启动冒烟 | flashmemo.exe 正常运行 |
| 空闲工作集 | ≈ 39 MB（指标 ≤ 60 MB，SPEC §17） |
| 数据目录 | `%APPDATA%\FlashMemo\data.db` 自动创建（WAL 模式） |

## 人工走查清单（运行 `npm run tauri dev`，注意需将 cargo 加入 PATH）

- [ ] 托盘图标出现，右键菜单五项齐全（SPEC §13）
- [ ] 关闭主窗口 → 隐藏到托盘；「退出」→ 进程结束
- [ ] 导入 `src-tauri/tests/fixtures/sample-mysql.md` → 预览 1 包/2 章/3 卡 → 确认导入
- [ ] 首页显示待复习 3 张 → 「立即复习」弹出复习窗（或等引擎 tick）
- [ ] 弹窗 440×380 无边框、不抢键盘焦点、位置随机且偏移
- [ ] 空格揭示答案 → 评分按钮显示下次间隔预览（如「良好 · 5分钟」）
- [ ] 学习卡按 1m/5m/10m 分钟级重弹（设弹窗间隔 5 分钟更易观察）
- [ ] 连评良好毕业 → 毕业卡 due_at 为天级（约 2~3 天，SQL 查 review 阶段卡）
- [ ] Esc/✕ → 未评分卡延后 30 分钟且不写 review_log
- [ ] 设置页改弹窗间隔/学习时段 → 保存后生效
- [ ] 暂停提醒 1 小时 → 时段内不再弹窗

## 已知 M1 边界（按计划留待 M2/M3）

- 复习批注三件套、连贯闪卡、疑难/归档、AI 侧栏 → M2
- 全屏免打扰、开机自启、导出、安装包 → M3
- 通知点击跳转（当前仅提示文案）、托盘 hover 统计文案为静态
