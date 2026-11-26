# OpenClaw 2026.11.10 跨 channel 移植評估

查核日期為 2026 年 11 月 26 日。比對兩個正式版 commit 的完整樹差異，再用 Mattermost Custom 的 11.10 候選原始碼確認落差。範圍涵蓋兩版 `extensions/*/openclaw.plugin.json` 宣告 `channels` 的 28 個擴充套件，另查 Gateway 內建的 WebChat／Control UI。

| 比對來源 | 版本身分 |
| --- | --- |
| OpenClaw 2026.11.7 | `e31bbf056de321127988ec5c1a36ff1b59297de0` |
| OpenClaw 2026.11.10 | `6ea542fd97e2876aa4c871ccc494ed5419a03c5c` |
| Mattermost Custom | HEAD `b307d1062aeed7e8f31ff3a7eef2b48de328876e`，加上已驗證的 11.10 適配，候選 tree `f5ee48479bb2a8fe673916a1a6ae07dff260b817` |

[11.10 官方發布說明](https://docs.openclaw.ai/releases/2026.11.10) · [兩版原始碼比較](https://github.com/openclaw/openclaw/compare/e31bbf056de321127988ec5c1a36ff1b59297de0...6ea542fd97e2876aa4c871ccc494ed5419a03c5c) · [下游 11.10 適配驗證](../.artifacts/operations/adapt-2026.11.10/RESULT.md)

## 建議第一批移植

1. **保留帶連結預覽的人類貼文。** 伺服器加上預覽後，貼文可能帶有 `slack_attachment` type。下游即時 ingress、thread 歷史回補及 dead-letter 原文讀回都把任意非空 type 視為應略過。官方 Mattermost #193836 只略過 `system_*`。下游三條路應共用相同的判斷，既有 sender／bot 政策、刪除檢查及 typed post 的 debounce 邊界仍各自適用。驗證人類文字加預覽能進 turn、真 system post 和遭拒 sender 仍被擋下、歷史回補及原文讀回接受同一類貼文。這項優先處理，因為目前可直接從過濾條件證明整則訊息會被丟棄。[上游 ingress](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/mattermost/src/mattermost/monitor-posts.ts#L96) · [下游 ingress](../src/mattermost/monitor-posts.ts#L101) · [歷史回補](../src/mattermost/monitor-thread-backfill.ts#L154) · [dead-letter](../src/mattermost/monitor-dead-letter.ts#L57)

2. **補齊單附件長 caption 與 message tool 的 Markdown 切塊。** 官方 Mattermost #192481 將附件和 caption 第一段放在首則，其餘文字接在同一 thread。下游直接傳送只在 `grouped && message` 時切 caption，單檔入口會略過。沿用既有的分段發送、首段附件／按鈕與部分送達收據。#196331 修正另一個入口，將 message tool 的 chunker 換成懂 fenced code block 的 Markdown chunker。下游雖設定 Markdown 模式，配置的 `chunkTextForOutbound` 仍只按換行或空白切；一般 inbound reply 已經使用 Markdown chunker。驗證跨長度上限的 code fence、首則才附檔和 controls、續段 thread、續段被拒絕時首則收據與恰好一次上傳。[上游傳送](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/mattermost/src/mattermost/send.ts#L272) · [上游 adapter](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/mattermost/src/channel.ts#L424) · [SDK 通用 chunker](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/src/plugin-sdk/text-chunking.ts#L15) · [下游傳送](../src/mattermost/send.ts#L695) · [下游 adapter](../src/channel.ts#L947)

3. **讓 `message edit` 也清理本機檔案死連結。** Discord #199958 讓 edit 走 send 的文字渲染。Mattermost Custom 已在 send、一般回覆和串流處理死連結，但 edit 的純文字和 presentation 路徑會直接送出文字。把既有的本機連結轉換放進兩個 edit 路徑，並以 provider 實際文字做 readback。驗證有空格的絕對路徑和 `file:` 連結保留標籤，HTTPS、inline／fenced code 保留，既有 controls 和顯式 attachment 選擇照常，本文中的路徑不觸發讀檔或上傳。[Discord edit](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/discord/src/actions/runtime.messaging.messages.ts#L117) · [下游 edit](../src/mattermost/message-actions.ts#L137) · [下游 send](../src/mattermost/send.ts#L619)

## 值得做的功能

**從既有 thread 用 `/fork` 開同一 channel 的新 thread。** Slack 11.10 支援一般 thread 訊息 `@OpenClaw /fork [title]`，Telegram 也用同一個 SDK hook 開 forum topic。Core 的 `conversationBindings.prepareFork` 已出現在 11.10 published SDK，下游 Mattermost 目前沒有註冊這個入口。這是這輪最值得借鑑的新增功能，適合單獨交付。Mattermost adapter 需要確認原始 post 的作者、channel 與 root，重新驗證 membership 和目前帳號權限，由 Core 複製與綁定會話，再把 Mattermost 建立的同 channel 新 top-level post 當作 thread root。驗證公開／私人 channel、有效 thread、遭撤權及送出結果不明時只建一個 root。[Slack adapter](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/slack/src/fork.ts#L16) · [Telegram adapter](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/telegram/src/thread-bindings-channel.ts#L25) · [SDK 契約](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/src/channels/plugins/types.conversation-bindings.ts#L7) · [Core `/fork`](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/src/auto-reply/reply/commands-fork.ts#L150)

## 先用回歸測試確認的候選

| 候選 | 要確認的 Mattermost 行為 |
| --- | --- |
| 串流 preview 下方已有新貼文時避免雙份答案 | 官方 Mattermost #198206 在第一次把 answer 寫到舊 preview 前就檢查。下游在 finalizer 才檢查，而 REST preview 和 companion 都能在此前更新。重現「進度 → 同 thread 新貼文 → answer → final」，再測 task-card 交接、其他 thread、工具或純附件。只把 provider 可見且接受的本文記為已送達。[上游](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/mattermost/src/mattermost/draft-stream.ts#L90) · [下游串流](../src/mattermost/draft-stream.ts#L238) · [下游 finalizer](../src/mattermost/monitor-draft-delivery.ts#L146) |
| 一次普通按鈕點擊只留下單一入口 | 官方 Mattermost #201973 以 synthetic inbound 傳達普通 callback。下游 durable 和直接 fallback 路徑各自還有 `enqueueSystemEvent`。先驗證普通 tap 在 transcript 是否重複，並查舊 observer；問答、核准、密碼對話框、typed payload 和 replay 冪等都要分別測。[上游](https://github.com/openclaw/openclaw/commit/b3f7309146a) · [下游 durable](../src/mattermost/interactions.ts#L760) · [下游 fallback](../src/mattermost/interactions.ts#L1198) |
| Context compaction 提示有自己的貼文 | Telegram 將 progress 模式的 compaction block 交給獨立的 send，避免被最終答案覆蓋或隨 draft 刪除。下游有 `isStatusNotice` 的 final 特判，沒有 `isCompactionNotice` 的專用分流。先用 Core 真實 payload 驗證是否會被吸進 draft，並涵蓋 task card、最後答案及 host 關閉提示的情況。[Telegram](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/telegram/src/bot-message-dispatch-reply.ts#L444) · [下游 block](../src/mattermost/monitor-turn.ts#L707) · [下游 final](../src/mattermost/monitor-draft-delivery.ts#L85) |
| 排隊後撤權與 restart custody | Discord/官方 Mattermost 改用含 `contextBinding` 的 host 入站契約。下游在 durable claim dispatch 會重讀設定及 access。先測 claim 已交給 host 佇列之後才撤權的情況，並測舊 plugin generation 退役、已收件的 queued final 與 cleanup 是否仍能結束。11.10 公開 Core 內已有 ingress custody 與 delivery consumer 引用管理，以及含 Matrix 的回歸。下游 account ingress 建立於 WebSocket reconnect loop 外，普通 reconnect 不會重建它。這些是重現線索，舊 Mattermost 事故的同因與修復須靠精確配對環境證明。[Discord admission](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/discord/src/monitor/message-handler.admission.ts#L164) · [Core custody](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/src/plugins/runtime/runtime-channel.ts#L173) · [Core Matrix 回歸](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/src/plugins/runtime/runtime-channel.delivery-custody.test.ts#L532) · [下游 ingress scope](../src/mattermost/monitor.ts#L345) |
| 中止時釋放尚未交付的附件暫存 | Zalo User 會刪除剛存妥、但因權限／生命週期變動而無法交付的 buffer。下游 save 後檢查 abort 時可以直接 `break`，且目前依賴型別沒保留 `SavedRemoteMedia.id`，要先證明這個時點還持有該 buffer。驗證只清掉本次未交付的 buffer，已交給 turn 或由其他 turn 持有的檔案仍可讀。SMS 的 abandon/drop 清理也適合作為測試參考。[Zalo User](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/zalouser/src/monitor.ts#L585) · [下游附件](../src/mattermost/monitor-resources.ts#L96) |
| 斷線期間、尚未進 SQLite 的訊息 | WhatsApp 只為已完成初次歷史同步的帳號回覆近期 `append` 訊息；Mattermost thread backfill 把歷史帶進下一輪，與斷線訊息主動補收不同。若有實際漏接樣本，再評估小範圍 provider 讀回、每帳號 checkpoint 和按 post id 去重。保留 fresh install、live reconnect race、原有 thread/mention 政策的測試。[WhatsApp](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/whatsapp/src/inbound/message-delivery.ts#L190) · [下游 backfill](../src/mattermost/monitor-thread-backfill.ts#L69) |

另一項可小批補入的是 **directory NFC 搜尋**。Buzz、Slack 及官方 Mattermost 都會以 NFC 比對名稱，能匹配由不同 Unicode 序列組成的相同字形。下游 name/display name 比對只轉小寫；可以只標準化比較值，provider 名稱與 ID 原樣回傳。[官方 Mattermost](https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/extensions/mattermost/src/mattermost/directory.ts#L58) · [下游 directory](../src/mattermost/directory.ts#L68)

## 逐 channel 摘要

| Channel | 11.7 → 11.10 變化與 Mattermost 判斷 |
| --- | --- |
| A2A | 同一 active run 只投影這次 dispatch 新增的 finals。A2A task projection 專用，沒有對應的下游 task API。 |
| Buzz | Unicode directory 查詢可借鑑，官方 Mattermost 同版也採用。 |
| ClickClack | Discussion 綁定、撤權、路由與附件狀態依賴 GitHub Discussion 身分。Mattermost 已有 inbound media failure context，可延續 11.7 的可見通知提案。 |
| Discord | Edit 共用 renderer 值得先移植。即時授權與待辦 mention 優先順序需要獨立回歸。後者涉及 durable queue 的排序及可信的 provider mention facts。 |
| Feishu | 原生訊息 UUID 重試、provider 媒體處理及 topic anchor。Mattermost 已有自己的 synthetic anchor 投影；傳輸重試須以 Mattermost 收據判斷。 |
| Google Chat | Provider link 標記的自我標籤 `mailto:` 呈現。Mattermost 原生 Markdown 無同一轉換。 |
| iMessage | Send-health 警示與 probe 分開，另外更新 `imsg` 診斷。可在證明 Mattermost 有同類監控缺口時借鑑。 |
| IRC | Monotonic 計時與 literal tab 保真。Mattermost 保留 Markdown，沒有 IRC 的文字投影路徑。 |
| LINE | 兩欄 email 表格與 `mailto:` 去重，依賴 LINE 的表格與文字轉換。 |
| Matrix | 恢復同步、pin/spoiler、媒體和 thread binding 涉及 Matrix SDK。Queued consumer 修復值得對照 Core custody 與下游 account lifetime。 |
| Mattermost | 連結預覽與 caption/chunker 優先；preview 重複、普通 callback 雙入口及 host context binding 各自驗證。 |
| MS Teams | SharePoint 檔案、首次 DM、approvals 與串流 final 失敗 fallback。Mattermost 已有自己的 thread、媒體與 send 收據；串流 final 的重複風險列在上方。 |
| Nextcloud Talk | Polling／節流使用 elapsed time。下游可在重現 wall-clock 跳動造成 backfill cooldown 異常時參照。 |
| Nostr | 先用完整 Markdown 渲染純文字再切塊，避免片段被二次解讀。概念支持在 Mattermost 使用各入口共同的文字處理，純文字投影屬於 Nostr。 |
| QA Channel | 測試 channel 的 embedded dispatch 與 fixtures。 |
| Raft | 套件版本更新，未見可移植的 runtime 功能。 |
| Reef | terminate 後等 socket `close` 再結束，避免 TLS close 握手懸留。Mattermost abort 已 terminate，尚無同類資源延遲的證據。 |
| Signal | Sender/quote attribution、文字格式、view-once／不可用附件占位，以及 signal-cli 生命週期。下游已有不可用附件的 agent context；Signal 的 view-once 保護與原生 UUID／alias 屬於 provider。 |
| Slack | `/fork` 推薦獨立實作。Native streaming 失效後改回一般 post、媒體 final 結束 progress，對照下游 partial-send 與 task-card 持有關係。Socket Mode 本身由 Slack 管理。 |
| SMS | Callback body 配額及 adopted MMS 的 abandoned/dropped cleanup。附件 custody 可作為下游 abort 回歸參考。 |
| Synology Chat | Webhook/進程生命週期及 literal text 清理以 Synology 送出協定為準。 |
| Telegram | Topic routes/fork、rich blocks、callback、draft lane 和 readback。Mattermost 已有獨立的 thread routing 與 Markdown；跨入口 rendering 的已證落差列在上方。 |
| Tlon | Club approval、引用範圍、原生 list 和有標點／格式的 mention。身份證明及原生 list 依賴 Urbit 提供的事件。 |
| Twitch | 套件與測試更新，未見可移植的 runtime 功能。 |
| WhatsApp | 權限、LID、voice-note codec、初次同步與近期離線訊息。只把離線補收保留為 Mattermost 候選，voice note 與 LID 由 WhatsApp 協定負責。 |
| X | 新增事件類別、即時與 backfill 解耦、讀取 backpressure、驗證錯誤與 reconnect 狀態。若 Mattermost WebSocket admission 在慢消費時出現積壓，可借鑑限量做法。 |
| Zalo | Outbound 與 photo captions 套用 Markdown table mode；Mattermost send 已做 table conversion。 |
| Zalo User | 已存但未發布的 media buffer 清理可移植，先界定 ownership。 |
| WebChat／Control UI（另外查核） | 待處理 steer、編輯排隊訊息、失敗時復原輸入和 UI 送出回饋由 Gateway/Core 管理。Mattermost 可另做 `/fork` 類 provider 入口。 |

本次交付是原始碼稽核。既有 11.10 候選的 busy notice、local-file 降級、顯式附件和 standalone 驗證仍以適配報告為準。上述候選未寫入該候選 tree 或 tar。
