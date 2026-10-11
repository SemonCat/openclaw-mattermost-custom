# OpenClaw 2026.10.1 跨 channel 移植評估

研究日期：2026-10-11。比較官方 `v2026.9.8` 與 `v2026.10.1` 的
Slack、Telegram、Discord 原始碼及測試，再對照本 repository 的 Mattermost
實作。第一、二項已在 standalone plugin 實作並以 published SDK 驗證；
沒有安裝或重啟 Gateway。

## 結論與建議順序

| 順序 | 候選 | 版本歸屬 | Mattermost 的價值與工作量 |
| --- | --- | --- | --- |
| 1 | deferred ingress 釋放 lane | Discord 10.1 新接線；使用既有 SDK 能力 | 讓同串後續輸入能進入 core 排隊／steer。改動小，但 lifecycle 驗證要求高。 |
| 2 | session 的來源對話連結 | Slack 10.1 新接線 | 從 OpenClaw session 回到 Mattermost 原始訊息／thread。中；需接 metadata、browser accessory 與 standalone 打包。 |
| 3 | 模型與 runtime 一起選擇 | Discord 在 9.8 已有；10.1 修長 model ID | 免手打 `--runtime`，清楚選擇執行 runtime。中；仍須由 host 驗證及持久化。 |
| 4 | 按需下載對話附件 | Slack 在 9.8 已有；10.1 補圖片尺寸驗證 | agent 需要時讀取先前檔案，補上目前只有自動 reference media 的限制。中；須維持目前 conversation/account 讀取授權。 |

第一項是可靠性修正；第二項是這次版本最適合補入的介面能力。第三、四項是
10.1 裡可借鑑的既有功能，不能列成 10.1 新增。

## 1. deferred ingress 釋放 lane

Discord 的 [`monitor/ingress.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/discord/src/monitor/ingress.ts)
在 10.1 對 drain 加上 `deferredLaneOccupancy: "release"`。
SDK 的 [`ingress-drain.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/src/channels/message/ingress-drain.ts)
預設仍是 `"hold"`：deferred claim 保留 durable custody，但只有 opt-in 才會釋放 lane。
[`ingress-drain.test.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/src/channels/message/ingress-drain.test.ts)
的 `holds lanes by default and releases only opted-in deferred lanes` 明確測試同 lane
第二筆在 hold 模式不會開始、release 模式能開始。

本地 [`monitor-ingress.ts`](../src/mattermost/monitor-ingress.ts) 現已 opt-in `release`；
已具備 durable queue、heartbeat、adoption、cancel 和 restart recovery，仍可能在
一筆 deferred input 尚未被採用時擋住同 lane 後續訊息。這是原始碼證明的設定缺口，
尚未宣稱已在使用者的 live Gateway 重現。

移植時應只調整 owning drain 邊界，保留既有 SQLite queue 和 lifecycle。
驗收須涵蓋：同串 A deferred 後 B 能交給 core；A 仍保留 claim/heartbeat；
不同 thread 不串線；採用、取消、失敗及重啟重播不遺失或重複輸入；
同步 `onDeferred()`、尚未 await 的時序也正確。不能把 release 誤當 complete，
也不能讓 provider queue 取代 core 的執行順序管理。

## 2. session 的來源對話連結

Slack 10.1 新增
[`prepare-session-presentation.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/slack/src/monitor/message-handler/prepare-session-presentation.ts)
的 `resolveSlackConversationLink`，並在
[`prepare.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/slack/src/monitor/message-handler/prepare.ts)
透過 `conversation.link` 傳給 host。它使用可本地組合的 Slack redirect URL，
避免 session preparation 額外等待 permalink API，且保留既有 link。
Slack 同時在
[`browser/index.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/slack/browser/index.ts)
註冊 `session-header` accessory，並由
[`plugin manifest`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/slack/openclaw.plugin.json)
宣告 `controlUi.entry`。單加 metadata 不等於 Mattermost 介面就會顯示連結。

本地 inbound context 現已供應有效原生來源的 `ConversationLink`；
[`search.ts`](../src/mattermost/search.ts) 已有同 instance 的
`/_redirect/pl/<postId>` permalink 建構方式。可在 Mattermost context 補入來源
訊息或 thread 的有效 permalink，讓 host session 能保留回到原對話的位置。
這和現有 task card 的「前往子工作 session」連結方向不同。

驗收須確認既有 session/reset 行為、DM 與 thread、subpath base URL，以及
無原生 post ID 的 slash command：不能把 synthetic MessageSid 拼成 permalink。
來源只採用已授權事件與已驗證的 instance／post 身分；不從訊息文字取任意 URL
當可信 session metadata。可重用 published SDK 的 `control-ui` semantic component，
建立 Mattermost accessory、宣告及打包 browser entry，無須修改 host UI。
本地已確認 `createSessionHeaderLink`／`defineControlUiPlugin` 的 published exports；
仍須驗證外部 plugin 的 browser bundle 載入，以及來源 channel／instance 的顯示隔離。

## 3. 模型與 runtime 選單

Discord 的
[`model-picker.view.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/discord/src/monitor/model-picker.view.ts)
會列出 host 提供的 runtime choices，先暫存選擇再提交；
[`9.8 同檔`](https://github.com/openclaw/openclaw/blob/v2026.9.8/extensions/discord/src/monitor/model-picker.view.ts)
已具有這項能力。10.1 真正新增的修正是縮短顯示 label、讓選項值改用 model token，
避免 Discord 100 字限制破壞長 model ID；見
[`model-picker.state.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/discord/src/monitor/model-picker.state.ts)。

本地 [`model-picker.ts`](../src/mattermost/model-picker.ts) 已用 hash 產生 action ID，
完整 model 留在 callback context，不能直接套用 Discord 的 100 字規則。
真正缺的是 runtime 的原生選擇：
[`monitor-model-picker.ts`](../src/mattermost/monitor-model-picker.ts)
目前送出 `runtime: { kind: "unchanged" }`，選單文案要求手動使用
`/oc_model <provider/model> --runtime <runtime>`。

可重用目前受保護的選單及 host `models-provider-runtime`／`model-session-runtime`，
顯示目前 runtime，提供明確確認後再變更。不要因為瀏覽模型就自動換 runtime。
驗收涵蓋 catalog 熱更新、選項失效、長 ID、非 opener 點擊，以及完整模型／runtime
組合能由 host 接受並正確讀回。這些 SDK subpath 存在於已安裝的 published 10.1
package；仍須在實作時逐項驗證所用 named export。

## 4. 按需下載對話附件

Slack 的
[`channel-actions.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/slack/src/channel-actions.ts)
提供 `download-file`，
[`9.8 同檔`](https://github.com/openclaw/openclaw/blob/v2026.9.8/extensions/slack/src/channel-actions.ts)
已存在。10.1 的
[`action-runtime.download-image.test.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/slack/src/action-runtime.download-image.test.ts)
新增 configured image dimension limit 的驗證；不能把整個下載功能算成新功能。

Mattermost 目前有自動下載一個已授權 reference 的
[`reference-media.ts`](../src/mattermost/reference-media.ts)，以及只回傳附件 metadata 的
[`thread-tool.ts`](../src/mattermost/thread-tool.ts)，但
[`channel.ts`](../src/channel.ts) 沒有 generic `download-file` action。
可補一個讓 agent 指定 post/file 的 bounded 工具，按需讀取同一對話的較早檔案。

應沿用既有 read authority 和 trusted media saver，驗證 file 確實屬於目標 post，
限制 account、instance、conversation、檔案大小、總預算與 timeout，並遵守圖片
縮放設定。不得只憑 bot 能存取或知道 file ID 就授權下載，也不應為此擴大搜尋範圍。

## 已有對應或不直接移植

- Mattermost 已有 native commands、模型瀏覽、原生 approval／ask_user／secret dialog、
  signed callbacks、durable callback replay、task progress cards、tool preview、
  restart thread recovery、bounded search 和 referenced attachments；見
  [`README.md`](../README.md#downstream-behavior)。其他 channel 有類似 UI 不構成重做理由。
- Slack 10.1 整理 progress card 詳細度、fallback 長度與錯誤終態；見
  [`dispatch-progress-card.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/slack/src/monitor/message-handler/dispatch-progress-card.ts)
  和 [`progress-blocks.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/slack/src/progress-blocks.ts)。
  可以借測試案例，但不可套用會刪除／隱藏 plan card 的策略；本 repo 要求有效 plan
  留下 durable terminal card，並保留 task/result post 的排序與 identity handoff。
- Telegram 10.1 的 progress frame 可關閉 link preview；見
  [`draft-stream-message.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/telegram/src/draft-stream-message.ts)
  和 [`draft-stream.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/telegram/src/draft-stream.ts)。
  這是 Telegram Bot API 行為，尚未驗證 Mattermost 有等價的逐 post API，先不列立即移植。
- Telegram album 的收集／排序修正屬 provider 的多事件相簿語意。Mattermost 一個 post
  已有 `file_ids[]`；不要搬入 Telegram 的 album timer。若要多附件合併發送，那是另一個
  功能：目前本地 message action 明確拒絕一次多附件，普通 reply delivery 則逐檔發送。
- Discord 的長 model ID token 修正、語音／presence／guild 管理，以及 Telegram topics／
  polling／Mini App 均不能直接視為 Mattermost 缺功能。
- Telegram 10.1 的
  [`ingress supersede predicate`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/telegram/src/telegram-ingress-supersede.ts)
  限制只有明確 abort/reset 類命令可丟棄待處理輸入，避免 `/think`、`/verbose` 等設定命令
  使 pending question 消失；
  [`測試`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/telegram/src/telegram-ingress-supersede.test.ts)
  涵蓋保留設定／skill 命令前的輸入。這是 Telegram adapter 修正，本地沒有相同 supersede
  predicate，無須複製；第一項 release 改動應沿用這個不誤取消問題的驗收原則。
- Release notes 提到 workspace-qualified Slack users，但
  [`9.8 target parser`](https://github.com/openclaw/openclaw/blob/v2026.9.8/extensions/slack/src/target-parsing.ts)
  已有 workspace-qualified user 支援；不能只憑 release notes 把它列成新 port 功能。

## 較大的後續方向

Telegram 10.1 使用 debouncer 的 `shouldHoldFlush` 和 ingress 的 `readLaneBacklog`
補收已落盤、尚未 dispatch 的相鄰事件，並用 deadline 限制等待；見
[`inbound buffer`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/telegram/src/bot-handlers.inbound-buffer.ts)
及 [`album coalescing`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/telegram/src/bot-handlers.inbound-media.ts)。
Mattermost 尚未轉交 backlog reader，但沒有 Telegram album 的跨 update 語意；
只有實際看到 burst 訊息因排程延遲被拆批時，才值得補 bounded backlog-aware debounce。

Discord 的
[`conversation bindings`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/discord/src/thread-bindings-channel.ts)
和 [`binding lifecycle`](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/discord/src/monitor/thread-bindings.lifecycle.ts)
也值得作長期參考：讓一個 thread 綁定獨立的 ACP／worker session，持續直接對話。
這在 9.8 已有，且需要 persisted binding、health reconciliation 和權限生命週期；
工作量大，不是基本 thread routing 的缺口。現有 Mattermost thread session／子工作
progress cards 已能涵蓋一般工作，應有具體使用情境才啟動這項擴充。

## 範圍及驗證

官方來源固定在 `v2026.10.1` commit
`e178c39e9aae3fa440735217f9aef9574f286677` 與 `v2026.9.8` commit
`fc23bc864e4553c2d215e479eeec47b67a0bf943`；
[`10.1 release notes`](https://github.com/openclaw/openclaw/blob/v2026.10.1/CHANGELOG/2026.10.1.md)
只用來索引，功能歸屬以 tag 原始碼差異為準。

已實作第一、二項，其餘候選仍未實作。新增獨立 ingress lane suite 使用實際
SQLite queue 與 published SDK，不依賴 excluded monorepo suites。來源 helper、
channel/DM/thread/slash/generic interaction context、Control UI mount/update/隔離
另有 targeted coverage；完整 standalone Vitest、build 與 pack 證據由 task receipt 保存。

來源連結遵守 host 的 first launch link 語意：reset／provider switch 不輪替既有 link，
不修改 session state。UI 以目前 provider、明確 account 的 read-only `channels.status`
baseUrl 驗證 instance／subpath；同 instance 多 account 無法只靠 permalink 區分來源。
持續顯示期間使用 status snapshot；session/account、reconnect 或 presentation resume
才重新讀取，並未宣稱設定變動即時生效。沒有新的 privileged RPC 或 broad polling。
來源缺少有效 native ID（包括 flat slash 和無 author 證据的舊 callback）時不產生連結。

尚未做 live inbound／UI Gateway 驗證。部署後的 lifecycle 行為仍須在 parent 明確授權
安裝與重啟後，以新的 inbound Mattermost turn 驗證；source tests／archive smoke
不能取代 live proof。
