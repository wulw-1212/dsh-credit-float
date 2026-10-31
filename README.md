# dsh-credit-float

各渠道剩余积分显示在 DSH 窗口之外的桌面胶囊里，并提醒 `skills` 目录下的
第三方技能仓库是否有远端更新。

## 技能目录（多路径）配置

技能目录**只通过文件/环境变量配置，不在页面上设置**。插件会检查这些目录下
每个 git 仓库的远端是否有本地还没有的提交，有则提醒；点「全部更新」只在能
**纯快进**时更新，本地有未提交改动、有独有提交、或远端重写过历史都会跳过
并说明原因，绝不覆盖你的文件。

三个来源**合并去重**（不是互相覆盖），顺序固定：

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| 环境变量 | `DCF_SKILLS_DIRS` | 多个路径用 `;` 或 `,` 分隔 |
| 兼容别名 | `DCF_SKILLS_DIR` | 单个路径，等价于只写一个 |
| 配置文件 | `<插件目录>\skills-dirs.json` | `{"dirs": ["D:\\a\\skills", "D:/b/skills"]}` |
| 默认目录 | `$DSH_HOME\skills` | 始终参与，配置里再写也只是去重成一条 |

同一个目录用不同写法（`D:\a\b`、`D:/A/B/`、大小写差异）只会算一次。
配置文件**每轮检查都会重读**，改完下一次检查（或点面板「重查」）即生效，
不需要重启。文件带 UTF-8 BOM 也能正常解析。

`skills-dirs.json` 的示例内容：

仓库里带了一份 [`skills-dirs.example.json`](skills-dirs.example.json)，
把它复制成 `skills-dirs.json` 再改路径即可；**真实的 `skills-dirs.json` 已被
`.gitignore` 忽略**（里面是本机绝对路径，跟着仓库走会指向别人的磁盘）。
写路径建议用正斜杠（`D:/skills`）；用反斜杠必须写成两个（`D:\\skills`），
写成一个会让整个文件变成非法 JSON 而被整层跳过。

```json
{
  "dirs": [
    "D:/Programs Data/Dsh/Dsh-home/skills",
    "D:/my-own-skills"
  ]
}
```

环境变量示例（PowerShell，永久生效）：

```powershell
[Environment]::SetEnvironmentVariable('DCF_SKILLS_DIRS', 'D:\a\skills;D:\b\skills', 'User')
```

### 面板上有什么

只有「有远端更新」时才出现技能区块：每个仓库一行、「更新」按钮（单个）、
以及底部的「全部更新 / 重查 / 打开目录」。配置了多个目录时会按目录分组，
每个目录标题旁有「打开」。

## 环境变量参考

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `DCF_PORT` | `18733` | 桌面窗口的本地 HTTP 端口 |
| `DCF_SKILLS_DIRS` / `DCF_SKILLS_DIR` | — | 技能目录，见上 |
| `DCF_SKILLS_POLL_MS` | 6 小时 | 远端检查间隔 |
| `DCF_ELECTRON_PATH` | `$DSH_HOME/electron` | Electron 可执行文件位置 |
| `DCF_RESOLVE_RETRY_MS` | `5000` | 找不到 Electron 时的重试间隔 |

## 只读接口

桌面辅助进程在 `127.0.0.1` 上提供两个只读端点，方便脚本排查：
`GET /skills`（技能仓库更新状态）和 `GET /state`（积分状态）。
**更新技能目录只能通过面板按钮触发**——写操作不暴露在 HTTP 上，因为该端口
接受任意来源的请求。
