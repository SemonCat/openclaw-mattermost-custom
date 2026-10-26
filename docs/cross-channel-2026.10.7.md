# OpenClaw 2026.10.7：跨頻道移植與 Mattermost 串流研究

研究日期：2026-10-26。完整比較官方 `v2026.10.6` 與 `v2026.10.7` 的
Slack、Discord、Telegram 子樹，並逐一查閱官方 Mattermost Agents plugin
`v2.10.0` 及 mobile `v2.45.0` 的串流實作，對照本 downstream 插件的現有串流傳送。本文是研究與
移植建議，不改 runtime、依賴、設定或部署，不宣稱 live Mattermost acceptance。

## 決策摘要

- **10.7 沒有 Slack、Discord 或 Telegram 的功能修正可直接 port。** 三個完整
  extension 子樹在 10.7 都只有 package version、host peer、plugin API、
  build metadata 更新；各自的 runtime、tests、assets 和其他檔案都不變。
  這次跨頻道來源 delta 不產生 Mattermost runtime port。
- **OpenClaw 10.7 官方 Mattermost 也沒有串流新功能。** 它的完整 145 檔子樹
  只改套件版本合約；因此沒有新的 upstream Mattermost stream endpoint 或
  streaming implementation 可移植。[官方 Mattermost v10.7][mm107]
- **Mattermost Agents plugin 的即時串流確實存在，但不是 Mattermost 核心的
  通用 post streaming API，也不是 10.7 新增。** 最新 stable Agents `v2.10.0`
  使用 plugin WebSocket event `postupdate`；相同模式在 v2.9.0 已存在。
  Web/mobile 都有 Agents 專用事件 handler 與 UI。[Agents v2.10 stream][agents-stream]、
  [v2.9 stream][agents-stream-29]、[web renderer][agents-renderer]、
  [mobile handler][agents-mobile]。
- **本 plugin 已支援可見的逐步回覆。** 它以一般 Mattermost posts 建立 preview，
  透過 post edit 更新、節流與分段；最終文字可繼續沿用已確認的 preview
  identity。要採用 Agents 的 WebSocket push，需先定義標準 Mattermost web／mobile
  客戶端如何繪製，再處理自訂 client renderer 或 plugin UI 部署；目前沒有證據
  支持直接替換現有傳送路徑。
- **舊 backlog 要減項。** 10.6 已落地 silent send、channel/sender tool policy
  和一個 post 的有序多檔附件；10.7 沒改變這些結論。歷史 10.6 研究中已完成項目
  不再列為候選，其餘項目按效益、authority 風險和驗收需求排序。

## 發行身分與比較方法

截至 **2026-10-26**，Mattermost 官方 latest stable releases 導向 Server
`v12.0.1` (2026-10-22 12:26:41 UTC)、Agents plugin `v2.10.0`
(2026-10-19 17:34:58 UTC) 和 mobile `v2.45.0` (2026-10-15 06:34:02 UTC)。
Agents manifest 最低要求 Server `12.0.0`。[Server release][server-release]、
[Agents release][agents-release]、[mobile release][mobile-release]、
[Agents manifest][agents-manifest]。實作比對使用 pinned tag，不以 mutable `master`
代替。Server 12.0.1 的 release notes 是中等嚴重度安全修正，沒有宣告新增通用
post streaming API；Agents 2.10 的 MCP 連線提示、保留歷史的重新命名與待批准
狀態顯示，屬 Agents 產品功能，不是 OpenClaw channel adapter 可直接開啟的選項。

版本名 `2026.10.7` 不是日期。官方 OpenClaw 10.7 annotated tag object 是
`5c101ce5a0637df375c5f6ae49d44d0d27cc26b1`，peeled commit 是
`157d8c2bc3ea2fa183afdc11088e69690bf8e64e`。10.6 對應 tag
`3494baecba2366a89fa703158a2c2b5c9edcd6ba`，peeled commit
`fe06181dc5ecc01cf8904abbfc26925925efefbc`。版本身分、npm integrity、
引擎範圍和 Mattermost 判讀見[10.7 upstream review](upstream-2026.10.7.md)。

比較使用兩個固定官方 Git tag 的完整 extension 子樹，含 runtime、tests、
test-support、assets、metadata 等所有檔案；數字是以相對路徑和檔案內容比對，
不是功能數量。

| 官方完整子樹 | 10.6 檔數 | 10.7 檔數 | 修改 | 新增 | 刪除 | 未變 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `extensions/mattermost` | 145 | 145 | 1 | 0 | 0 | 144 |
| `extensions/slack` | 421 | 421 | 1 | 0 | 0 | 420 |
| `extensions/discord` | 730 | 730 | 1 | 0 | 0 | 729 |
| `extensions/telegram` | 505 | 505 | 1 | 0 | 0 | 504 |

10.7 唯一被改的檔案皆是各 extension 的 `package.json`：自身版本、
`openclaw` peer version、`pluginApi` 與 build version 一起升至 2026.10.7。
沒有新增或刪除 source／test 檔案。[Slack v10.7 package][slack-package]、
[Discord v10.7 package][discord-package]、
[Telegram v10.7 package][telegram-package]。

## 10.7 新增跨頻道移植候選

完整 delta 未發現新增 Mattermost 功能候選。以下留作其他版本真正出現行為變更時的
判斷準則，不能視為 10.7 port 計畫：

| 候選 | 10.7 證據 | Mattermost 決策 |
| --- | --- | --- |
| Slack／Discord／Telegram stream 行為或 lifecycle fix | 三個 extension 的 source／test 檔皆與 10.6 相同，只有 package version contracts 更新。[Slack v10.6→v10.7][slack-compare]、[Discord diff][discord-compare]、[Telegram diff][telegram-compare] | 不把 upstream streaming 的存在誤報成 10.7 的新功能；使用本地 Mattermost regression、provider REST／WebSocket contract 評估實際 defect。 |
| SDK/core host improvement | 本次工作的上游比較是三個 extension 子樹。Host 變更需使用 10.7 SDK/core source 與部署 host 的實際 contract 分別確認。 | channel plugin 不複製 host-owned queue、session、transcript、streaming scheduler 或 UI 改變；消費 published SDK，保持 ingress ownership、post identity 與 callback fencing。 |

截至本研究，沒有已由 10.7 跨頻道變更支持的 P1/P2 runtime port。從測試設計取用
完整路由矩陣仍可按需求進行，但它不是功能 port，且必須貼合 Mattermost 的 channel、
root/reply 和 slash 路由，而非照搬 Discord private-thread cases。

## 各頻道現有串流方式與可借鑑之處

此表比較的是 OpenClaw 10.7 pinned source 所用的既有方式，**不是 10.7 delta**。
Slack native stream 是最接近 provider-side append API 的模式；Discord、
Telegram 與 Mattermost 的可見 preview 都以一般訊息/貼文 create-edit 為主。

| 頻道 | OpenClaw v2026.10.7 現有方式 | Mattermost 移植判斷 |
| --- | --- | --- |
| Slack | `streaming.ts` 使用 Slack `chat.startStream`、`chat.appendStream`、`chat.stopStream` native transport，按 mode/config 有 draft preview fallback；stream chunks 可以組成 Markdown、plan、task 等結構。[Slack v10.7 `streaming.ts`][slack-stream-source] | 值得借它清楚的 start/append/stop ownership model 與 bounded lifetime。Mattermost reviewed REST API 沒有等價通用 stream endpoint；不能直接改成 Slack API call。 |
| Discord | `draft-stream.ts` 建立訊息後編輯同一 identity，預設 1,200 ms，並啟用 `coalesceInFlight: true`，可用 `minInitialChars` 等待首批內容。[Discord v10.7 `draft-stream.ts`][discord-stream-source] | **值得查核 in-flight 合併策略。** 本 plugin 用相同 public lifecycle helper，但沒有啟用此選項；保留其自身 preview finalization 與 late-plan identity handoff。 |
| Telegram | OpenClaw v10.7 answer stream 用普通 `sendMessage`／`editMessageText` 並可原地 finalize；上游 Telegram channel instructions 明確不把 `sendMessageDraft` 當答案 delivery，因 draft 是 private chat 30 秒 ephemeral preview，而完成答案仍需 persistent message。[Telegram v10.7 sender][telegram-stream-source]、[Telegram v10.7 streaming contract][telegram-stream-rules] | 這支持保留 Mattermost durable preview→final identity；不要將 ephemeral preview 當成 durable result。 |
| Mattermost custom | Create ordinary post，再以 REST edit 更新；不同 mode 支援 partial/block/progress/off。 | 已存在；先量測和小幅調整 preview 節流，再考慮新增 transport。 |

Slack 目前 provider API 的 `chat.startStream`／`appendStream`／`stopStream` 提供
原生訊息 stream，支援 Markdown 與 rich progress chunks；官方文件將 stream
lifetime 限在 10 分鐘，累積 Markdown 長度限制 12,000 字元。[Slack `chat.startStream`
API][slack-api-stream]。這些限制是 Slack surface contract，不能拿來推定
Mattermost API 限制或設計。

Telegram Bot API 10.3 的 `sendMessageDraft` 和 `sendRichMessageDraft` 會在
private chat 顯示 30 秒內的 ephemeral draft；完成結果仍須另外送出 persistent
訊息。API 的 `can_stop`／`keep_on_stop` 與 stop 事件提供 user-stop UI 的 provider
範例。[Telegram `sendMessageDraft`][telegram-api-draft]、
[Telegram `sendRichMessageDraft`][telegram-api-rich-draft]。OpenClaw Telegram 10.7
並沒有改用這些 endpoints，其 repo streaming instructions 指示持續用 send/edit，
最終原地完成，避免多一個 final bubble。

所以跨頻道**值得移植的是生命週期與 UX 模式**，不是 provider API：

| 候選 | 優先級／成本／風險 | 目前證據與接受條件 |
| --- | --- | --- |
| **Discord 的 in-flight 更新合併** | P2、small / medium lifecycle risk | 本地 [`draft-stream.ts`](../src/mattermost/draft-stream.ts) 未傳 `coalesceInFlight`。共用 [draft loop][draft-loop] 在 true 時把背景 send 期間收到的新值留到下一個節流窗口；預設則可在前次完成後立即繼續 flush。候選收益是慢 REST 下仍保持合併與節流，並非已證明的 live 效能問題。先以 deferred create/patch 驗證新值覆蓋舊值、背景 calls 的間距與數量，以及 explicit final/boundary flush 不等待背景窗口；測 error、abort、late-plan handoff、accepted-without-id 不重送，再決定是否啟用。 |
| **Mattermost Stop-generation 按鈕** | P2、small–medium / medium–high authority risk | Slack 的 [agent-session Stop handler][slack-stop] 將原生停止事件導向正常 `/stop` admission，授權後才禁止 buffered tail 發送；這個順序比單純停止 UI 更值得借。Mattermost custom 已有原生 `/stop` command，但未發現 preview 的 dedicated Stop control。可研究 HMAC-bound callback 綁定 account、channel/thread、clicking user、session incarnation 和 active run/task，走 host 的正式停止流程；published host API 是否能安全指定該 run 是實作前必要證明。測 concurrent user/turn、final/cancel race、權限、session replacement、同一 thread 後續新 run、replay 和 restart；不能只隱藏 preview 或猜 active session。參考 [native command registry](../src/mattermost/native-commands.ts) 及 [interaction callback path](../src/mattermost/interaction-ingress.ts)。 |
| **節流 cadence 量測與調整** | P2、small / low–medium risk | 一般 inbound Mattermost preview 現為 1,200 ms，config schema 沒有 throttle 欄位。先取 REST calls/message、使用者可見 latency、rate-limit/error 的本地 trace；若有證據證明等待過久，再考慮小幅變動或明確 bounded config，保留 Markdown chunking、hook gating、post order 和 cancellation fencing。不把每 token edit 當目標。 |
| **Agents-style custom WebSocket bridge** | P3、medium–large / high integration risk | 只有在確定 deployment 同時管控 Mattermost server plugin、Web 和 mobile clients 時再立項。需要跨系統 client tests 和 REST fallback；純 standalone OpenClaw channel plugin 沒有可呼叫的 Mattermost server `PluginAPI`。 |

## 仍有效的舊候選

以下項目不是 v10.7 新增；它們延續 [10.6 cross-channel research](cross-channel-2026.10.6.md)
的未結論。10.7 沒改變它們的信號或優先級。

| 候選 | 狀態 | 下一步證明 |
| --- | --- | --- |
| Slack relay error 時 join 已收件的 async ingress acceptance | P1、有條件、small–medium / medium risk。10.6 的 queue-boundary 分析仍有效，v10.7 Slack subtree 沒改此程式。現有 Mattermost ingress spool 也不等於 socket layer 已 join listeners。 | 先用 deferred `onPosted` 重現 message acceptance pending 時 error/close，觀察 connection settlement、status、enqueue 和 dispatch；只考慮 join durable admission，不把 agent run 卡在 socket close。 |
| Discord native-command registry 授權／路由矩陣 | P2、small / low–medium risk，屬測試設計，不是 runtime port。 | 若還缺覆蓋，再以 Mattermost 自己的 command registry 測 permit/deny、thread/root、plugin/core collision、session identity 和 unauthorized no-effect；不照搬 private-thread。 |
| Telegram rich-caption fallback | P3、有條件、small–medium / medium risk。v10.7 extension 未動此 rendering；Mattermost 的標準 Markdown table 已支援。 | 先證實實際 Mattermost payload 會裸露 rich tags，才做限於 caption 的 fallback；保留 code／escaped literals／一般 Markdown/table。 |
| Inbound top-level room history；explicit prior-file download；inbound post edit/delete awareness；complete thread/work-session binding | 分別仍是 P2、P2–P3、P3、P4；已有一般 read/search/reference hydration/action capability 不等同這些平台 lifecycle 能力。 | 延用 [10.6 research backlog](cross-channel-2026.10.6.md) 的 authorization、bounded media/history、dedupe、session incarnation 和 acceptance checks；不要用 10.7 只改版本宣告當完成證據。 |

## Mattermost 串流：兩種不同模型

### 這個 OpenClaw 插件的串流

本地 [Mattermost channel adapter](../src/channel.ts) 宣告 draft preview 和
preview finalization；host 的 streaming callback 把累積文字交給
[Mattermost draft stream](../src/mattermost/draft-stream.ts)。它以 `POST /posts`
建立 preview，再以 `PUT /posts/{id}/patch` 更新原本那個 post。writer 預設節流
1,000 ms，一般 inbound turn 明確設為 1,200 ms。Schema 支援 `off`、`partial`、
`block`、`progress`，account 未設定時預設 `partial`。超過 server/account
每 post 長度就按 chunk mode 分段。符合條件的 final 可在 readback 確認後沿用
preview identity。這是普通 post edit，web/mobile 用一般 post event 顯示，不是
每 token REST 呼叫，也不需自訂 client UI。[`draft-stream.ts`](../src/mattermost/draft-stream.ts)、
[`client.ts`](../src/mattermost/client.ts)、[`monitor-turn.ts`](../src/mattermost/monitor-turn.ts)、
[`accounts.ts`](../src/mattermost/accounts.ts)、[`monitor-draft-delivery.ts`](../src/mattermost/monitor-draft-delivery.ts)。

當 host 有 `reply_payload_sending` 或 `message_sending` hook 時，
[`monitor-turn.ts`](../src/mattermost/monitor-turn.ts) 會停用 provider preview，
避免尚未經過 rewrite/cancel gate 的文字先外流。串流加速或新 transport 不能繞過此條件。

README 亦有意區分工具／reasoning preview、final delivery、durable task card 和
重啟後暫時 preview。task card 絕不覆寫 result；plan 遲到且 commentary 已建立
result 時，會先 flush、複製成 successor result，再把舊 post identity 交給 card。
因此串流 identity 是 lifecycle contract 的一部分，不能只比較文字可見速度。
[`README.md` streaming and task-card contract](../README.md)。

### Mattermost Agents plugin 的串流

固定的官方 Agents v2.10 server plugin 在普通 Mattermost post 上以
`PublishWebSocketEvent` 發出 `postupdate`。每個 LLM text event 帶目前累積全文
`next`，不是單一 token delta；事件亦可帶 start/continue/end/cancel、reasoning、
tool calls、annotations 等。廣播以 channel 為範圍，標記 `ReliableClusterSend`。
完成、錯誤或取消時，Agents 透過一般 `UpdatePost` 寫回最終 post；live text 不會
逐次呼叫 posts REST edit。[Agents v2.10 `streaming.go`][agents-stream]。

Mattermost Server v12.0.1 的 server-plugin API 將 custom event namespace 前綴為
`custom_<pluginid>_`。[Server plugin API][server-plugin-api]。Agents webapp 註冊
`custom_mattermost-ai_postupdate`，其 renderer 依 `post_id` 在 UI state 更新文字、
tool 和 reasoning；重新載入則讀 persisted conversation state。[web registration][agents-web-registry]、
[web renderer][agents-renderer]。v2.9.0 已有相同的 stream event，故這不是 Server
12.0.1 或 Agents v2.10.0 新增功能。[v2.9 `streaming.go`][agents-stream-29]。

Mobile v2.45.0 也已整合 Agents event，但透過自己的 event constant、WebSocket
dispatcher 和 Agents streaming store；收到 end 後 refetch persisted conversation，
reconnect 時按 persisted anchor 判斷保留或清除 in-flight state。[mobile event constant][mobile-event]、
[mobile handler][agents-mobile]、[mobile stream store][mobile-stream-store]。
這證明 Agents UI 支援自家 event，不能推論標準 client 會把任意 plugin 的 custom
payload 顯示成普通 bot 即時文字。

Server v12.0.1 的 [Posts API][posts-api] 定義 create/update/patch，但本次查核的
固定 API spec 沒有通用 open/append/finish stream endpoint。`PublishWebSocketEvent`
是**跑在 Mattermost server 內的 server-plugin API**，不是 bot REST credential
可呼叫的介面。因本 repo 是 OpenClaw Gateway 的 standalone channel plugin，不在
Mattermost server plugin process 內，若要同樣的 push UI，需要一個 server-side bridge
和明確支援的 Web/mobile renderer；這是架構推論，不是 live deployment 測試結果。

所以 Mattermost 確有 plugin-specific 即時串流範例，但它不是可直接移植的通用
REST feature。若目標是降低 preview writes／延遲，優先把節流效果量測清楚；更快
更新可列為上表的 **P2 合併與節流查核**。Telegram 提供 Stop-generation 的 UX 參考，
但不是 Mattermost 10.7 port。

| 項目 | 最低接受條件 |
| --- | --- |
| Server bridge | 定義 OpenClaw Gateway 如何可信地交付 stream 狀態給 Mattermost server plugin；event 依 channel/thread 範圍傳播並核准權限、可靠性、schema version。不能假裝一般 bot REST 呼叫可使用 `PluginAPI.PublishWebSocketEvent`。 |
| Web/mobile renderer | 若加入 companion，就明確部署並測試 Web 和 mobile 的 listener/renderer；沒有 companion 的 client 仍用普通 post edit。不得由 web component 測試推定 mobile 支援。 |
| Message semantics | 保持單一 post identity、Markdown 未完成語法處理、surrogate/chunk boundary、取消與工具邊界、late-plan task-card handoff、final edit/readback、重啟後可恢復。不得把 ephemeral event 說成 durable transcript。 |
| Load/failure proof | 量測完整累積文字的 event 廣播與 1,200 ms REST edits 的流量、延遲和遺失率；測 reconnect、cluster routing、abort、重複/掉序 event、最終 persistence、edit readback fallback 和 accepted-without-id no-retry。 |

未安裝 companion UI 或未確認可用的 server bridge 前，維持普通 post draft preview
是較低風險的跨 client 串流。現況沒有證據支持移除它、提高 token-frequency 或
在本次新增 server／client companion。

後續針對第 3 項完成了 [WebSocket 串流可行性研究](mattermost-websocket-streaming-feasibility-2026.10.7.md)：
OpenClaw 公開 SDK 足以供應串流，並以真實 SDK finalizer、官方 web listener 和 mobile
stream store 通過 12 個本機案例。瓶頸在 Mattermost 的 server-plugin namespace、renderer
與執行所有權；另查到 Agents → OpenClaw SSE 的可行介面，但尚需 session／授權整合及實際連線驗證。
這份後續本機證據不代表 companion 已實作或 live UI 已驗證。

## 已完成能力與重新排序的舊 backlog

歷史 [10.6 跨頻道研究](cross-channel-2026.10.6.md) 曾把幾項功能標為待考慮；
之後 10.6 下游適配已實作，README 已記錄。以下項目從 backlog 移除，不再推薦重做。

| 先前候選 | 現況 |
| --- | --- |
| Silent outbound message | 已實作 per-send `silent: true`，text/media/payload 走 Mattermost `?silent=true`，保持正常 send receipts／unknown-send 分類，只有具 integration-author authority 的 bot 成功。外部部署仍需 server 支援。 |
| Channel/sender tool policy | 已保留 published SDK 的 group `tools`／`toolsBySender` schema，由 host resolver fallback 套用；不額外複製 resolver。 |
| One-post multi-attachment collections | 已實作有序多檔先 upload 再一次 create，inbound ordinary reply 亦使用同一 sender；有每 post 10 檔與 20 MiB aggregate 上限，失敗不悄悄改成多個可見部分貼文。 |
| Mattermost long-message capability | 已自動學習 Mattermost 12 per-post limit，對一般 reply、message tool、preview 和 recovery 套用有效限制。 |
| Task/progress streaming semantics | 已有 durable task card、result identity 分離、late-plan successor handoff、yield/continuation 和 restart preview；維持相關排序和 authority invariants。 |

未完成項目排序：

| 優先級 | 候選 | effort / risk | 接受前證明 |
| --- | --- | --- | --- |
| P2 | **History room root posts**：restart 後的新 top-level channel turn 從 Mattermost API 取得有限歷史，補足僅 thread root 有 durable history 的缺口。 | medium / medium-high | 授權 room/thread visibility；filter future/deleted/system/bot-progress；去重 current/debounce posts；bounded limit/abort；確認 history 不被當成新的 agent turn。 |
| P2–P3 | **Explicit prior-file download action**：由模型要求已可讀歷史 post 中指定附件，而非只靠當前 inbound reference hydration。 | medium / high authority risk | 下載前再次證明 post/channel/thread/sender access；走安全 media saver、SSRF/local-root/size/time/cancel limits；僅看 metadata 不得自動下載。 |
| P3 | **Inbound post edit/delete awareness**：為已消費訊息的 edit/delete 增加限定範圍的通知或策略。 | medium / medium-high | 定義已經執行 agent turn 後 edit/delete 的語意；排除 bot 自身 preview/card edits；去重/reconnect；測 root/reply session identity。不能只 port Slack 的事件名稱並改寫歷史。 |
| P3 | **Durable polls/rich sections 的需求評估**：確認現有 reactions、buttons/select 和 choice form 以外的具體需求。 | small–large / medium–high | 區分 transient `ask_user`、persisted channel poll、web/mobile section renderer；只新增已證明需要的 capability，定義 restart 與 terminal callback semantics。 |
| P4 | **Complete thread/work-session bindings adapter**：補齊 host current-conversation binding 以外的 durable focus/bind、child placement 和 unbind lifecycle。 | large / high | 使用 published host binding service；測 account/channel/thread、current vs child、expiry、restart restore、session replacement、stale effect authority。增加旗標不等於完成 binding。 |

原研究的 silent send、groups tool policy、grouped attachment 不再標示 P2/P3
欠缺；已完成能力不代表目標 server/installation live smoke 已驗證。README 中
仍有效的限制與正式介面才是實際 runtime contract。

## 官方來源

OpenClaw 的 tag-pinned 一手比較／source：

- [10.6...10.7 full monorepo compare][openclaw-compare]
- [Official Mattermost v10.7 subtree][mm107]
- [Official Slack v10.7 package][slack-package] 與 [v10.6...v10.7 diff][slack-compare]
- [Official Discord v10.7 package][discord-package] 與 [v10.6...v10.7 diff][discord-compare]
- [Official Telegram v10.7 package][telegram-package] 與 [v10.6...v10.7 diff][telegram-compare]
- [Mattermost Agents streaming implementation v2.10.0][agents-stream]
- [Mattermost Agents renderer v2.10.0][agents-renderer]
- [先前 v2.9.0 已有的串流][agents-stream-29]

## 證據與驗證界線

原始 cross-channel archive diff、完整 file inventory 和計數保存在
`/tmp/openclaw/mattermost-adapt-2026.10.7/cross-channel/`。
Mattermost release HTML、發布時間、官方 source、archive SHA-256 與 provider API
快照保存在 `/tmp/openclaw/mattermost-streaming-research-2026.10.7/`。
GitHub API 查詢遇到 rate-limit 403，latest release 身分改由官方 release 頁面的
redirect 和時間核對；不能把 API 403 當成沒有 release。

本輪只新增研究文件，做 source、diff 和文件引用檢查；沒有修改實作、執行新測試、
安裝、Gateway 重啟、對外訊息、commit 或 push。前一輪 10.7 適配的測試／build
收據不代表上述候選已驗證。現行部署 server/mobile/plugin 版本也未在本輪讀回。
若未來接受 lifecycle port，先重現 owning regression，跑 standalone narrow/full/build；
部署後另以新 inbound turn 證明 post 順序與 identity、取消及 terminal card 行為。

[openclaw-compare]: https://github.com/openclaw/openclaw/compare/v2026.10.6...v2026.10.7
[mm107]: https://github.com/openclaw/openclaw/tree/v2026.10.7/extensions/mattermost
[slack-package]: https://github.com/openclaw/openclaw/blob/v2026.10.7/extensions/slack/package.json
[slack-compare]: https://github.com/openclaw/openclaw/compare/v2026.10.6...v2026.10.7
[discord-package]: https://github.com/openclaw/openclaw/blob/v2026.10.7/extensions/discord/package.json
[discord-compare]: https://github.com/openclaw/openclaw/compare/v2026.10.6...v2026.10.7
[telegram-package]: https://github.com/openclaw/openclaw/blob/v2026.10.7/extensions/telegram/package.json
[telegram-compare]: https://github.com/openclaw/openclaw/compare/v2026.10.6...v2026.10.7
[slack-stream-source]: https://github.com/openclaw/openclaw/blob/v2026.10.7/extensions/slack/src/streaming.ts
[slack-stop]: https://github.com/openclaw/openclaw/blob/v2026.10.7/extensions/slack/src/monitor/events/agent.ts
[discord-stream-source]: https://github.com/openclaw/openclaw/blob/v2026.10.7/extensions/discord/src/draft-stream.ts
[draft-loop]: https://github.com/openclaw/openclaw/blob/v2026.10.7/src/channels/draft-stream-loop.ts
[telegram-stream-source]: https://github.com/openclaw/openclaw/blob/v2026.10.7/extensions/telegram/src/draft-stream-message.ts
[telegram-stream-rules]: https://github.com/openclaw/openclaw/blob/v2026.10.7/extensions/telegram/AGENTS.md
[slack-api-stream]: https://docs.slack.dev/reference/methods/chat.startStream/
[telegram-api-draft]: https://core.telegram.org/bots/api#sendmessagedraft
[telegram-api-rich-draft]: https://core.telegram.org/bots/api#sendrichmessagedraft
[server-release]: https://github.com/mattermost/mattermost/releases/tag/v12.0.1
[agents-release]: https://github.com/mattermost/mattermost-plugin-agents/releases/tag/v2.10.0
[mobile-release]: https://github.com/mattermost/mattermost-mobile/releases/tag/v2.45.0
[agents-manifest]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.10.0/plugin.json
[agents-stream]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.10.0/streaming/streaming.go
[agents-stream-29]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.9.0/streaming/streaming.go
[agents-renderer]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.10.0/webapp/src/components/llmbot_post/llmbot_post.tsx
[agents-web-registry]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.10.0/webapp/src/index.tsx
[agents-mobile]: https://github.com/mattermost/mattermost-mobile/blob/v2.45.0/app/products/agents/actions/websocket/index.ts
[mobile-event]: https://github.com/mattermost/mattermost-mobile/blob/v2.45.0/app/constants/websocket.ts
[mobile-stream-store]: https://github.com/mattermost/mattermost-mobile/blob/v2.45.0/app/products/agents/store/streaming_store.ts
[server-plugin-api]: https://github.com/mattermost/mattermost/blob/v12.0.1/server/public/plugin/api.go
[posts-api]: https://github.com/mattermost/mattermost/blob/v12.0.1/api/v4/source/posts.yaml
