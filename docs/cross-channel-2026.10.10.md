# OpenClaw 2026.10.10 跨頻道移植研究與實作

研究日期：2026-11-04。基線為本 checkout 已完成的 10.10 source candidate，
包含先前 10.9 跨頻道研究後實作的四項功能。使用者核准後，本輪已移植下列三項
plugin 功能；沒有安裝、重啟 Gateway 或送出外部訊息。

## 結論與排序

這次值得先處理的是交付正確性與通知體驗：

| 優先 | 參考來源 | Mattermost 可移植項目 | 判斷 |
| --- | --- | --- | --- |
| 1 | Telegram 的答案、delta 與 status notice 分離 | **狀態通知不能覆寫答案 preview**；明確 delta 累積。 | 已實作；snapshot 和一般 authoritative final 仍可替換答案。 |
| 2 | Slack compact progress；Matrix mention-inert preview | **自動進度與 task card 不意外通知他人**，保住答案的正常交付。 | 使用 Mattermost 原生 silent create；答案接手時建立一般 successor。 |
| 3 | Discord ambiguous-delete reconciliation | **暫時性刪除失敗後的 preview cleanup 收斂**。 | 已限制在 owner-held preview，兩次 DELETE、十秒總 budget、失敗後讀回。 |

## 實作決策與驗證邊界

- `monitor-turn.ts` 僅累積明確的文字 answer delta；media、presentation、interactive、
  channel data、非 answer lane 與不同 reply root 維持原路徑。保留 inter-chunk
  whitespace 和重複 chunk，snapshot 可縮短更正，assistant message/followup 邊界重設
  accumulator。使用 published `reply-payload` metadata helper 去除後續 chunk 的
  response prefix，不依賴 monorepo-only testing export。
- `monitor-draft-delivery.ts` 在 final status notice 前 retain preview；
  `monitor-turn.ts` lossless flush 並結束 companion generation 後獨立送 status。
  status 發送失敗也不得刪除原答案；accepted-without-id 維持 terminal。
- Mattermost v12 的 `silent=true` 是 create 選項，server 管理並保留
  `silent_notification`；不能用 props 假造或靠 edit 移除。故不照搬 Slack escaping。
  `update()` 的自動進度在 monitor/recovery 路徑 opt in silent；
  `updateAssistantText()` 的答案如接手 silent post，先建立一般 successor、關閉舊
  companion lease，再清理原進度。直接 final 也不得原地升格 silent post。
  純 assistant preview 保留原通知語意，不宣稱修正普通 preview 編輯新增 mention 的
  server 限制。新 task card silent，late-plan 複製純進度仍 silent；答案 handoff
  維持原有通知 policy。文字、URL、程式碼和 structured snapshot 不改寫。
- `deleteMattermostPreview` 僅用在 draft 與 retained-progress cleanup，不改
  message action 或 thread-move delete。最多兩次 DELETE，共享十秒 signal/deadline；
  transient network、429、5xx 後 GET；404 或已軟刪確認不可見，200 才可能重試。
  初次 DELETE 404、401/403、不確定的讀回都不當成成功，取消後不再讀回／重試。
  這只證明貼文不再可見，不證明 server 附件等後續清理已完成。

回歸測試涵蓋實際 REST fixture、companion lease、late-plan identity handoff、
續跑 adoption 拒絕後的一般 final、status 失敗保留答案、delta/snapshot/final 分類、
DELETE 歧義與取消。這些是 source/provider-fixture 證據；沒有發送 live Mattermost
notification probe。正式通知、fresh inbound task/result 身份與排序，仍需獲授權
安裝並重啟後確認。完整 gate 與 exact-diff review 結果記在 operations 的
`validation-summary.json`；本文後續章節保留原調查證據與採用理由。

## 來源與調查深度

以 canonical core checkout 的 immutable tag objects 做唯讀比較：

- `v2026.10.9`：`8b18b5578f66eab1501cba4cef2310d88bfb9a41`。
- `v2026.10.10`：`7dc3350cb9f08fcf9a0af5c4845a20d5b2f1a8be`。

先盤點帶有 `openclaw.channel` package metadata 的 28 個 extension 子樹；
深入核對 Slack、Discord、Telegram，以及 Matrix、Teams、Feishu、Google Chat、
WhatsApp、Signal、LINE、IRC、iMessage、Nextcloud Talk、Tlon 的相關 source、
測試及 downstream 對應路徑。其他子樹依 runtime diff 分流，沒有把全部檔案都當成
逐行審查完成。Reef、ClickClack 等較大的變動主要涉及其自身 state/trust/binding
模型，不據此替 Mattermost 新增系統。

官方 10.10 原始碼亦已解開在
`.artifacts/operations/adapt-2026.10.10/openclaw-2026.10.10/`；
本輪 inventory、secondary audit 與重現結果放在同一 operations 目錄的
`cross-channel/`。未以 live core `dist` 建立相容性主張。

來源：[官方 tag compare](https://github.com/openclaw/openclaw/compare/v2026.10.9...v2026.10.10)、
[release notes](https://github.com/openclaw/openclaw/blob/v2026.10.10/CHANGELOG/2026.10.10.md)。

## 1. 答案與狀態通知分離

Telegram 10.10 在 final payload 為 `isStatusNotice: true` 時，先保留已串流的
答案，再獨立送出狀態通知。其明確 `textMode: "delta"` 的 answer blocks 則追加到
同一答案；一般 final 仍以自身內容替換 preview，不能用前綴猜測取代這個分類。
重複出現的相同 delta 也可能是合法答案內容，不能僅因文字相同就去重。

上游證據：

- [`bot-message-dispatch-reply.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.10/extensions/telegram/src/bot-message-dispatch-reply.ts#L357)：status notice 分支，以及 `canStreamBlock`／delta 追加。
- [`bot-message-dispatch.preview.telegram-http.test.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.10/extensions/telegram/src/bot-message-dispatch.preview.telegram-http.test.ts#L26)：partial/block、response prefix、重複 delta、authoritative final 與 ACP status notice 的實際 HTTP 測試。

原調查時 downstream 的
[`buildFinalEdit`](../src/mattermost/monitor-draft-delivery.ts#L116)
排除 media、error、presentation、不同 reply root，卻沒有區分 status notice。
本輪透過 Vite 載入真正的 downstream helper，並使用已安裝
`openclaw@2026.10.10` 的 `createLivePreviewLifecycle`，在記憶體 provider fixture
先放置一則答案 preview，再送：

```json
{ "text": "Session ids resolved.", "isStatusNotice": true }
```

實際觀察到唯一 API 呼叫是 `PUT /posts/preview/patch`，原本的
`The substantive answer is already visible.` 被改成 `Session ids resolved.`，
helper 仍回傳 `visibleReplySent: true`。這證明 **adapter 分支會覆寫答案**；
尚未用完整 Gateway producer 或 live Mattermost turn 證明發生頻率。
重現結果保存在 operations 的 `status-notice-reproduction.json`。

建議先做小範圍修正：final status notice 使用獨立交付，已可見的答案保留其身份與
內容；維持 task card 在上、result 在下，以及 Stop、companion、accepted-without-id
的既有契約。測試應同時證明 status notice 不覆寫答案、一般 authoritative final
仍正常替換、通知發送失敗不刪掉答案、receipt 對應真實貼文。

Delta 是相關但獨立的增強。目前
[`onPartialReply`](../src/mattermost/monitor-turn.ts#L918)
使用完整 snapshot 替換，且 preview 啟用時
[`disableBlockStreaming`](../src/mattermost/monitor-turn.ts#L848) 為 true。
不能單純改成一律追加，否則會破壞既有縮短／更正 snapshot 的支援。
若後續支援 ACP block delta，應明確區分追加與替換，涵蓋 prefix、連續相同 chunk、
多個 assistant message 及 final replacement。所需的
`stripReplyPayloadResponsePrefix`、`isReplyPayloadTerminalContent` 已由 published
10.10 `reply-payload` subpath 匯出，不需引入 core 私有路徑。

## 2. 進度訊息不意外通知其他人

Slack 10.10 為 compact progress／preamble 加上 `escapeMentions`，並讓 mention
escaping 穿過最終 Markdown renderer，避免後續 render 又把文字變回可通知的控制。

Matrix **在 10.9 已經有** `includeMentions: false` preview 和 mention-bearing final
fresh-send 模式；10.10 的真正修正是在 mentions 為空時仍輸出 `m.mentions: {}`，
避免 legacy push rules 從內文重新辨識名字與 `@room`。不應把整套 preview/final
模式都誤稱為 10.10 新功能。

上游證據：

- [Slack draft renderer](https://github.com/openclaw/openclaw/blob/v2026.10.10/extensions/slack/src/draft-stream.ts#L109)、
  [progress caller](https://github.com/openclaw/openclaw/blob/v2026.10.10/extensions/slack/src/monitor/message-handler/dispatch-progress.ts#L386)、
  [mention-safe edit test](https://github.com/openclaw/openclaw/blob/v2026.10.10/extensions/slack/src/draft-stream.test.ts#L424)。
- [Matrix empty metadata fix](https://github.com/openclaw/openclaw/blob/v2026.10.10/extensions/matrix/src/matrix/send/formatting.ts#L51)、
  [focused edit test](https://github.com/openclaw/openclaw/blob/v2026.10.10/extensions/matrix/src/matrix/send.test.ts#L998)、
  [final-before-redaction trace](https://github.com/openclaw/openclaw/blob/v2026.10.10/extensions/matrix/src/__traces__/final-mentions-fresh.trace.jsonl)。

原調查時 Mattermost 直接發送
[`preview 文字`](../src/mattermost/draft-stream.ts#L162)與
[`task card 內容`](../src/mattermost/task-progress-card.ts#L363)，沒有這類
origin-aware mention transform。一般 message send 已支援 `silent`，因此本候選
不是再新增一個 silent send 開關，而是限制模型生成的 plan、tool progress、
compaction 標題等自動內容不意外 ping 到人。

Mattermost v12 source 定義了 `silent_notification`、`mentionHighlightDisabled`、
`disable_group_highlight` 等不同 props；這些名稱與欄位存在，不能推論它們都等同
Matrix 的 empty mention metadata。`PostPatch.DisableMentionHighlights` 處理的
亦是 channel/all/here 類型，不足以證明所有 user mentions 都被抑制。
來源：[post model](https://github.com/mattermost/mattermost/blob/v12.0.0/server/public/model/post.go#L101)、
[patch highlight helper](https://github.com/mattermost/mattermost/blob/v12.0.0/server/public/model/post.go#L1298)。

實作採用經 v12 server source 核對的原生 silent，並以一般 successor 避免永久
silent 的答案。REST 與 companion、late-plan identity handoff、thread scope 和
發送失敗均納入 regression；仍**沒有 live notification probe 結果**。
Silent create 與 edit 保留行為的來源為
[API create](https://github.com/mattermost/mattermost/blob/v12.0.0/server/channels/api4/post.go)、
[app create/update](https://github.com/mattermost/mattermost/blob/v12.0.0/server/channels/app/post.go)、
[notification](https://github.com/mattermost/mattermost/blob/v12.0.0/server/channels/app/notification.go)。

## 3. 暫時性失敗後的刪除收斂

Discord 10.10 將 edit/delete/pin/unpin 納入 request retry。DELETE 另外追蹤
前次是否可能已成功；只有在這個條件下，重試收到 Unknown Message 才視為成功。
第一個 404、無權限或其他資源錯誤不能一律吞掉。

來源：[mutation implementation](https://github.com/openclaw/openclaw/blob/v2026.10.10/extensions/discord/src/send.messages.ts#L177)、
[mutation retry tests](https://github.com/openclaw/openclaw/blob/v2026.10.10/extensions/discord/src/send.sends-basic-channel-messages.test.ts)。

目前 Mattermost 的 message-only edit 已有
[`updateMattermostPostMessageWithReadback`](../src/mattermost/client.ts#L1056)，
GET／明確 opt-in mutation 亦有 bounded 429 retry；不能把這些能力當成缺失重寫。
但 [`deleteMattermostPost`](../src/mattermost/client.ts#L1076)
只有一次 DELETE，沒有 opt-in rate-limit retry 或 uncertain-delete 收斂。
因此這個方向的價值是減少 final 已送達、preview cleanup 卻暫時失敗後的殘留。

建議限制在已證明由本 turn 擁有的 preview cleanup：有限時間／次數、取消後停止，
provider 結果仍不確定時保留真實失敗狀態。不能複製 Discord error code；要先定義
Mattermost deleted post/readback 與 permission-denied 的區別。測試至少涵蓋
429、暫時性 5xx、response lost、初次 404、取消及 final 不重送。
本輪未重現 live 殘留；實作僅新增 preview 專用 reconciliation policy。

## 不建議重複或直接移植

- **既有四項跨頻道能力**：room history、歷史附件、preview Stop、
  inbound edit/delete awareness 已在
  [10.9 研究後實作](cross-channel-2026.10.9.md)，不再列為新功能。
- **SDK async/state 遷移、picker transcript、pairing queue、preview pacing**：
  本次 [10.10 適配](upstream-2026.10.10.md)已處理適用部分；Matrix 的
  `coalesceInFlight` downstream 也已具備。
- **Telegram draft-retirement／question queue**：值得借用其事件順序測試案例，
  但目前未證明 Mattermost 也會吞掉 question，不據此重寫既有 queue 或 lifecycle。
- **Slack／Discord 名稱解析後綁定 policy ID**：Mattermost group context 目前直接
  使用 channel ID／wildcard，不為借用這項修正新增 name-policy resolver。
- **Discord CRLF、Teams list/code formatting**：各 provider formatter 不同；
  Mattermost outbound 已使用 host Markdown/chunking boundary，未找到對應重現。
- **Teams unresolved allowlist、LINE denied loading、Signal SSE、WhatsApp socket
  recovery**：需維持相關安全性，但各自的 protocol／UX 修正不是 Mattermost 功能。
  現有 authorization、durable ingress、unknown-send reconciliation 不能被繞過。
- **Telegram DM avatar**：確實是 10.10 新增的 bounded background portrait resolver，
  可作為未來 UI metadata 增強，但目前效益低於答案保護與通知體驗，先不排入前三項。

本輪使用 source/tag diff、published SDK 宣告、adapter 最小重現與 regression。
套件、來源雜湊、standalone gate 和 exact-diff autoreview 由本輪 operations
紀錄更新；先前套件的雜湊不能代表本輪候選。部署後的 fresh inbound live proof
不屬於這次未部署的 source 驗證。
