# OpenClaw 2026.10.9 跨頻道移植研究

研究日期：2026-10-30。比對官方 10.8→10.9 各 channel extension，並把先前
Slack／Discord 候選對照本插件現況及 Mattermost Server 12 API。本文保留原始
研究，並記錄其後獲授權的四項實作；不表示 live Mattermost 已驗證。

## 原始研究結論

**10.9 沒有新增值得移植到 Mattermost 的其他 channel runtime 功能。**
Slack、Discord、Telegram、Feishu、Google Chat、Synology Chat 與 Tlon 在此版本
都只有 package metadata 變更；Microsoft Teams 只有 MSAL 相容性測試變更。
其他 runtime 修正分屬 Codex、IMAP 或 core，沒有 Mattermost channel adapter 的
對應功能。

若要排下一批 Mattermost 專屬增強，建議先做兩項 bounded feature：

1. **頂層頻道近期歷史回填**：Gateway 重啟後在新 root-channel turn 提供有限、
   經授權過濾的對話上下文。中等成本，適合先做。
2. **讀取歷史貼文附件**：讓模型在讀過同一授權對話的附件 metadata 後，能按需
   下載舊檔。中等成本，但檔案與 channel 權限驗證風險較高。

入站 edit/delete 通知和 preview Stop 按鈕有明確 UX 價值，分別需要先定義已消費
內容的修訂語意，以及證明按鈕只會取消原使用者授權的當前 run，建議排在之後。

## 來源範圍

官方 OpenClaw 10.8 與 10.9 使用完整 tag archives 比對 extension manifests 和
檔案內容，涵蓋 runtime、tests、support files 與 metadata。Mattermost 本地基線是
目前 10.9 checkout；API 證據使用官方 Mattermost v12.0.0 OpenAPI 與 server source。
完整來源清單及 patch 保存在
`/tmp/openclaw/mattermost-adapt-2026.10.9/cross-channel/`。

| 10.9 官方子樹 | 比對結果 |
| --- | --- |
| Mattermost、Slack、Discord、Telegram、Feishu、Google Chat、Synology Chat、Tlon | 每個子樹只有 `package.json` 更新。 |
| Microsoft Teams | package metadata 加一個 MSAL 相容性測試；沒有 runtime 變更。 |
| Codex、IMAP | runtime／測試變動各屬自己的 channel 或郵件協定，沒有可直接移植的 Mattermost 行為。 |

官方來源：[10.8→10.9 比較](https://github.com/openclaw/openclaw/compare/v2026.10.8...v2026.10.9)、
[10.9 Slack](https://github.com/openclaw/openclaw/tree/v2026.10.9/extensions/slack)、
[Discord](https://github.com/openclaw/openclaw/tree/v2026.10.9/extensions/discord)、
[Telegram](https://github.com/openclaw/openclaw/tree/v2026.10.9/extensions/telegram)、
[Feishu](https://github.com/openclaw/openclaw/tree/v2026.10.9/extensions/feishu)。

## 原始候選排序

| 優先 | 可移植的功能模式 | Mattermost 現況與 provider 支援 | 評估 |
| --- | --- | --- | --- |
| 1 / P2 | **頂層頻道近期歷史回填**。Slack 會為 room turn 取回受限、可見性過濾後的歷史。 | 插件已有 `fetchMattermostChannelPosts` 和 bounded thread recovery；`monitor-posts.ts` 只有存在 thread root 時才回填。新頂層 room 的短期 `channelHistories` 是記憶體狀態，Gateway 重啟後不會從 Mattermost 補回。Mattermost `GET /channels/{channel_id}/posts` 支援 page/before/after，要求 `read_channel` 權限。 | **建議先做。** 中等成本、中高權限風險。只為新 inbound turn 補有限歷史；重用 live sender/context visibility policy，排除目前與 debounce 中的 post、future/system/bot progress posts，並保留 abort、去重與 session-incarnation fence。不能讓歷史貼文成為新 turn。 |
| 2 / P2–P3 | **按需取得已讀歷史貼文的附件**。Slack `download-file` action 重新讀 metadata，並驗證檔案仍屬授權對話。 | `mattermost_thread` 可回傳舊附件 metadata；search 可定位舊貼文，但不會下載附件。目前沒有 message action 可指定舊附件供模型閱讀。Mattermost 提供 `GET /posts/{post_id}/files/info` 和 `GET /files/{file_id}`；取得檔案要求 `read_channel` 權限或為該檔 uploader。現有 `downloadMattermostFile` 是 move-thread 流程用的 buffer helper，含 move-specific 限制／錯誤訊息，不能直接當安全媒體工具。 | **值得做，先後於歷史回填。** 中等成本、高權限風險。由已授權 post 證明 file ID、channel/thread 和 sender visibility，再經 trusted media saver，沿用大小／時間／取消／SSRF 限制。僅取得 metadata 不自動下載；不能以 file ID 或 bot membership 單獨授權。 |
| 3 / P3 | **入站 post edit/delete awareness**。Slack 將訊息修改／刪除事件作為可辨識的 subtype。 | Mattermost v12 定義 `post_edited` 和 `post_deleted` WebSocket events；此插件只 dispatch `posted`，並另外處理 reaction events。既有 edit/delete message actions 是 bot 的 outbound 操作，並未通知 agent 使用者修改或刪除來源訊息。 | **有用但先定語意。** 中等成本、中高生命週期風險。第一版可在正確 channel/thread session 送 bounded、deduplicated correction/deletion notice；忽略 bot 自己的 preview/task-card edits。不得暗示能改寫已消費 transcript、取消工作或自動重答。另需證明 reconnect 去重及已刪 root 的 routing。 |
| 4 / P2，有條件 | **preview Stop 按鈕**。Slack 的 Stop event 走既有 `/stop` admission。 | Mattermost 已有 `/stop` 與 signed interactive callbacks，但 preview 沒有 Stop control。10.9 published SDK 提供 agent-harness abort API；仍需證明正確 run/session incarnation 綁定，以及其權限與 queue admission 和 native `/stop` 一致。 | **有條件再做。** 使用者可在手機直接停止長任務，價值清楚；但授權風險最高。必須簽署 source post、點擊者、account、thread、session incarnation 和 run identity，並測 replay、多人並發、final/cancel race、session replacement 和 restart。不可只隱藏 preview 或 abort「目前同 session 任一 run」。 |

## 暫不列入

- **持久化多使用者 poll**：Mattermost form 是短期、單一 pending Gateway 問題，不等同跨重啟團隊投票。若有明確投票需求，需另設 durable poll/vote state、投票者權限、改票／重複規則與結束生命週期；不能由 Telegram/Discord poll payload 直接移植。
- **更完整 work-session binding**：Mattermost 現已支援 native thread/session routing，SDK factory 也提供 current-conversation binding。剩餘需求是 durable focus/bind、child placement、unbind 和 restart restore；改動大，先確認實際 ACP/subagent 使用情境。
- **重做 draft coalescing、Feishu snapshot tests、Telegram recovery typing tests**：10.8 跨頻道研究後，Mattermost 已增加 snapshot／工具邊界與 recovery-typing regressions，並為 REST preview 啟用 `coalesceInFlight`。不要重複 port。
- **native footer、長訊息、silent send、tool policy、有序多附件、forms、task cards、thread recovery**：README 已記錄為現有能力；其他 channel 有類似實作，不代表 Mattermost 缺功能。

## Provider references

- Mattermost v12 [`GET /api/v4/channels/{channel_id}/posts`](https://github.com/mattermost/mattermost/blob/v12.0.0/api/v4/source/posts.yaml#L675)：bounded channel-history endpoint，`read_channel` 權限。
- Mattermost v12 [`GET /api/v4/posts/{post_id}/files/info`](https://github.com/mattermost/mattermost/blob/v12.0.0/api/v4/source/posts.yaml#L567) 與 [`GET /api/v4/files/{file_id}`](https://github.com/mattermost/mattermost/blob/v12.0.0/api/v4/source/files.yaml#L92)：讀取 post 附件 metadata 與檔案的 API／權限契約。
- Mattermost v12 [`WebsocketEventPostEdited`／`WebsocketEventPostDeleted`](https://github.com/mattermost/mattermost/blob/v12.0.0/server/public/model/websocket_message.go)：server 的事件名稱與事件類型。
- OpenClaw v10.9 [Slack room-history adapter](https://github.com/openclaw/openclaw/blob/v2026.10.9/extensions/slack/src/monitor/message-handler/prepare-room-history.ts)、[file action](https://github.com/openclaw/openclaw/blob/v2026.10.9/extensions/slack/src/actions.ts) 與 [Stop handler](https://github.com/openclaw/openclaw/blob/v2026.10.9/extensions/slack/src/monitor/events/agent.ts) 是可參考的生命周期模式；它們不是 10.9 新增功能。

## 已選定的實作

四項候選均已實作於這次 10.9 candidate；它們參考其他 channel 的既有模式，
並非宣稱上游 10.9 新增這些功能。

| 功能 | 實作契約 |
| --- | --- |
| 頂層 room 歷史 | 延伸既有 thread backfill：一頁、200 posts、五秒；沿用 historyLimit、sender/context visibility、session incarnation 與取消 fence。排除目前 debounce batch、其他 thread、bot/system/deleted/future posts；flat DM 不新增 room recovery。 |
| 歷史附件 | `message` 的 `download-file` 接 `postId`/`messageId` + `fileId`。`actions.downloadFiles` 預設 true，可全域/帳號停用，與 opt-in `messages` 獨立。限定 trusted sender 的當前帳號/對話；貼文、檔案與 sender visibility 驗證後經 trusted saver 下載，再確認仍有該檔。總期限十秒、最多 20 MiB（effective media limit 更小時從小）。不新增 plugin tool capability。 |
| Preview Stop | 簽署 callback 與 source-owned in-memory nonce；只允許原 sender，重跑目前 native command authorization。使用公開 `GetReplyOptions.abortSignal`，與 ingress adoption signal 合併以涵蓋 queued follow-up；不依 session ID 取消替代 run。REST 隱藏 integration 時以 bot-authored post custody marker 檢查；舊 callback/restart replay 永遠被消耗，不發動新 turn。 |
| Edit/delete | 真實 WebSocket event 經現有 SQLite durable ingress，以 post + revision 分離 create/edit/delete 去重身份，沿用原 thread lane。只向已存在的正確 session 增加 bounded、quoted untrusted edit 或 identity-only delete notice；忽略 bot/system，不改已消費 transcript、不自動回覆。await 期間取消或 session rotation 會阻止發布。 |

Stop 出現在 REST/companion result preview，late-plan handoff 仍將舊 post 轉為
task card、後繼 post 接續 result；Stop 後 card 為 cancelled。完成時只移除自己的
control，保留 final text 與其他 props。provider cleanup 失敗時按鈕可能仍可見，
但 registry 已退休，無法再取消任何工作。

驗證使用 published npm SDK 與 standalone test boundary，涵蓋完整 page scope、
sender visibility、real post-handler context、durable revision replay、取消／deadline、
附件 ownership、REST/companion Stop、session replacement 與 late-plan post identity。
完整 gate、review 與 artifact receipts 另存
`/tmp/openclaw/mattermost-features-2026.10.9/`。
未安裝、未重啟 Gateway、未變更 production config，
也未送出 live Mattermost 訊息。上線後仍需新的 inbound turn 驗證實際控制、post
順序及終態；重啟續跑既有 turn 不等同 fresh inbound lifecycle proof。
