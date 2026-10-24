# OpenClaw 2026.10.6：Mattermost sunset 與跨頻道移植研究

研究日期：2026-10-23。比較官方 `v2026.10.5` 與 `v2026.10.6` source archive，對照本 checkout **目前含既有未提交清理及 lifecycle 變更的檔案**，並納入獨立 Mattermost／SDK 查核。本文只新增研究文件；沒有改實作、版本、依賴、設定或既有文件，也沒有執行 build、test、安裝、服務操作、訊息發送、commit 或 push。以下測試皆為未來驗收建議，不是本次通過紀錄。

## 決策摘要

- **沒有新增可直接 sunset 的 Mattermost 功能。** 官方 Mattermost 145 個檔案中僅 `package.json` 改版，另外 144 個逐位元相同；不能以 SDK 有共同 primitive 或其他頻道修正，當成 downstream 已被替代的證據。[官方比較][compare]、[Mattermost package][mm-package]；本地現況見 [README](../README.md) 與 [10.5 audit](porting-audit-2026.10.5.md)。
- **10.6 最有用的新模式是可靠性與驗證方式。** Slack 的 pending acceptance 收尾可作 Mattermost 有條件調查項；Discord 的完整 command registry／授權矩陣值得借用測試設計。Telegram caption 降級只在證實同類輸入會進入 Mattermost 後考慮。三者均不是已證實、可立即套用的 Mattermost 功能缺陷。[Slack relay][slack-relay]、[Discord registry tests][discord-registry]、[Telegram format][tg-format]。
- **typing、ingress refresh 診斷及 direct status 修正由 host／SDK 擁有。** 未來支援 10.6 時消費正式套件，不複製 core 實作；保留本地 recovery、spool 與 authority fencing。[typing][typing]、[ingress drain][drain]、[status][status]。
- **七項舊 backlog 仍需分別決策，沒有因 10.6 自動完成。** 優先考慮明確 silent send 與群組 tool policy；explicit download、room history、edit/delete notice、同 post 多檔、完整 work-session binding 依需求排程。以下會修正「Discord 多 URL 即同 post 多檔」及「沒有 binding 支援」這兩種過度推論。[本地舊研究](cross-channel-port-review-2026.10.5.md)、[SDK factory][factory]、[Discord payload][discord-payload]。

## 發行身分、日期與比較覆蓋

版本名稱是 `2026.10.6`，**不是 2026-10-06 發行日期**。官方 release HTML 記錄發佈時間為 **2026-10-22 12:53:10 UTC**；研究日 exact npm 與 `latest` metadata 均指向 `2026.10.6`。annotated tag object 為 `3494baecba2366a89fa703158a2c2b5c9edcd6ba`，peeled commit 為 `fe06181dc5ecc01cf8904abbfc26925925efefbc`；舊版 archive commit 為 `1b58cb9a1b4f4353e1add63c8506db4d890962e8`。[官方 release][release]、[10.6 package][package]、[固定 commit][commit]。npm integrity／shasum 與下載身分由本次外部 evidence receipts 保留；GitHub API 的 403 是 rate limit，不能解讀為沒有 release。

逐檔比較涵蓋下列**完整子樹**，含 package、runtime、tests 與 test-support，不只讀 changelog。數字是相對路徑與內容比較，非功能數量，也不是整個 monorepo 的檔案總數。原始 `extensions-*.json/.diff`、`src-*.json/.diff` 及重新核對的 `cross-channel-counts-verified.json` 保存在外部 evidence root；官方變更入口為 [10.5…10.6 比較][compare]。

| 完整子樹 | 10.5 檔數 | 10.6 檔數 | 原檔修改 | 新增 | 刪除 | 未變 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `extensions/mattermost` | 145 | 145 | 1 | 0 | 0 | 144 |
| `extensions/slack` | 420 | 421 | 6 | 1 | 0 | 414 |
| `extensions/discord` | 728 | 730 | 9 | 2 | 0 | 719 |
| `extensions/telegram` | 505 | 505 | 8 | 0 | 0 | 497 |
| `src/plugin-sdk` | 747 | 749 | 5 | 2 | 0 | 742 |
| `src/channels` | 523 | 523 | 4 | 0 | 0 | 519 |

三個跨頻道合計 26 個變更路徑；四個頻道含 Mattermost 為 27。SDK public export map 為 **344 → 345 個 SDK entries**，只新增 `./plugin-sdk/path-existence-runtime`，沒有移除或改變既有 target；這不是整個 npm `exports` 總數，也不證明所有型別／行為均相容。[新 helper][path-existence]、[官方 package][package]。官方 [10.6 changelog][changelog] 將本版定位為 focused reliability patch，沒有新 user-facing features；這是版本宣告，本文仍以 source delta 決定可移植性。

## 三個頻道完整 delta 分類

下表列出全部變更檔案；同一格的 runtime 與 test 檔案分開說明意義。三個 `package.json` 都提高自身版本／host 或 plugin API 宣告，不是要求本研究更動 custom package。[Slack package][slack-package]、[Discord package][discord-package]、[Telegram package][tg-package]。

| 頻道與完整變更路徑（相對該 extension） | 10.6 實際改變 | Mattermost 判斷 |
| --- | --- | --- |
| Slack `package.json` | 版本合約 | 未來相容性工作；本次不改版本。 |
| Slack `src/rich-text.ts`；`src/data-table.test.ts`；新增 `src/monitor/message-handler/prepare-content.test.ts` | `renderSlackRichText` 優先保留 date fallback，缺值時將有效秒數轉 UTC ISO；測試含 timestamp 0、無效數字、escaping 與表格 fallback。[source][slack-rich]、[tests][slack-content-test] | Slack rich-text AST 專屬。Mattermost inbound 是原生 post message，沒有同樣 date element parser；沒有證據要另加日期解碼器。 |
| Slack `src/monitor/provider-support.ts` | observer 常數改名，實際字串值不變。[source][slack-provider] | 命名清理；不值得移植。 |
| Slack `src/monitor/relay-source.ts`；`src/monitor/relay-source.test.ts` | error 改走 `settleReject`，先等 pending durable acceptance，再結束 connection promise；新增 blocked acceptance＋socket error 回歸。[source][slack-relay]、[test][slack-relay-test] | **有條件可靠性候選 A**；必須比較 Mattermost 的 promise，而非只看到 spool 就判等價。 |
| Discord `package.json` | 版本合約 | 同上。 |
| Discord `src/monitor/native-command.interaction-boundary.test.ts` | parent／public thread／private thread，raw 與 hydrated identity，status/help、autocomplete、picker 及 denied parent 測試矩陣。[tests][discord-boundary] | **測試設計候選 B**；不是新的 slash runtime fix。 |
| Discord 新增 `src/monitor/native-command.plugin-dispatch.registry.test-support.ts`；`src/monitor/native-command.plugin-dispatch.test.ts` | 遍歷真 registry 與 dynamic skill，分別觀察 status、picker、args menu、普通 command dispatch；deny 時不得先讀 catalog 或產生 effect。[tests][discord-registry] | 可借測試矩陣；不要複製 monorepo test-state infrastructure，也不能把 mocked dispatcher 當 core execution 證據。 |
| Discord `src/voice/realtime-session.runtime.ts`；`src/voice/realtime-speaker-session.ts`；`src/voice/session.ts`；`src/voice/voice-runtime.ts`；`src/voice/voice-session.ts` | 區分 abort 與 text-fallback；離開 voice call 後，已進行的 agent consult 可回原 voice channel 文字；manager shutdown／replacement／授權變更仍阻擋，送出前重新確認 context 與 generation。[session][discord-realtime]、[delivery][discord-voice-delivery] | Discord voice transport 專屬。可參考「降級也重驗 authority」原則，但 Mattermost 無這條 voice-call lifecycle；不建新 fallback 子系統。 |
| Discord 新增 `src/voice/realtime-text-fallback.test.ts`；`src/voice/realtime-voice-selection.test.ts` | reply／cancel／permission／shutdown／revoked／replacement；duplicate consult 只跑一次，manager stop 中止 retained delegation。[tests][discord-voice-test] | voice 修正驗證；不能據此移除 Mattermost 自己的取消／失效 fencing。 |
| Telegram `package.json` | 版本合約 | 同上。 |
| Telegram `src/fetch.ts`；`src/fetch.test.ts`；`src/network-config.ts`；`src/network-config.test.ts` | DNS result-order 型別跟 resolver 走；`ipv4first` 預設停用 family racing，保留明確 override，接受 process `ipv6first`。[resolver][tg-network]、[fetch tests][tg-fetch-test] | Telegram transport 的 DNS／Undici 決策。Mattermost REST 與 WebSocket 分走其既有 SDK transport，未證實同缺陷；不搬 Telegram env/config 或全域 DNS 修改。 |
| Telegram `src/format.ts`；`src/format.test.ts`；`src/outbound-media.ts` | `3)` 也保留 list boundary spacing；media caption 啟用 rich-tag 降級：list／checkbox／aside／hr，保留 code、escaped examples 與 Markdown escape parity。[format][tg-format]、[media][tg-media]、[tests][tg-format-test] | **有條件呈現候選 C**；不是通用 Mattermost HTML rendering 支援。 |

## 新模式的可採納範圍與最低證明

### A. WebSocket 結束前收妥已接收的 acceptance：值得先證明，不能宣稱已等價

Slack `runRelayWebSocket` 維護串接的 `pending` promise。10.6 的 `onError → settleReject(error)` 會移除 listeners，等待 `pending` 後才 reject；`acceptRelayEvent` 完成後才 ack。其新測試刻意卡住 acceptance 再製造 socket error，確認 recovery 不搶先開始。[官方實作][slack-relay]、[官方回歸][slack-relay-test]。

custom 的實際鏈是 [monitor.ts](../src/mattermost/monitor.ts) `createMattermostConnectOnce({ onPosted: ingress.receive })` → [monitor-websocket.ts](../src/mattermost/monitor-websocket.ts) 的 async `message` listener `await opts.onPosted(raw)` → [monitor-ingress.ts](../src/mattermost/monitor-ingress.ts) `receive` 的 `await monitor.admit(rawEvent)`。**WebSocket 層沒有追蹤這些 listener promise 的 pending 集合／tail**：error 會先發 recovering status 並 `ws.close()`；已認證的 close 直接 `resolveOnce()`，不 join `onPosted`。事件 emitter 不會替 close handler 等待 async message listener。

SDK `createChannelIngressMonitor.scheduleAdmission` 則有自己的 `admissionTail`，將 inspect、prune、enqueue／append retry 串行化；`stop()` 會等此 tail。[admission][ingress-monitor-admission]、[stop][ingress-monitor-stop]。本地 [ingress-queue.ts](../src/mattermost/ingress-queue.ts) 的 enqueue 雖以同步 SQLite transaction commit，但整條 `admit` 仍可能等待既有 tail、prune 或 retry。不能由「enqueue 用同步資料庫」推成「socket error 到來時 acceptance 一定已完成」。

因此 source 支持的結論是：**Mattermost connection settlement／recovering status 可以早於舊 connection 的 acceptance 完成；SDK 序列化並不等於 socket join。** 但 ingress monitor 建於 reconnect loop 外，重連不會直接丟棄它；monitor 整體結束時才 `await ingress.stop()`。這些保護仍在，故目前**未證實資料遺失、重複 dispatch 或實際 live 缺陷**。Mattermost 也沒有 Slack relay ack／router redelivery，不能照搬 protocol。

使用者收益是讓 reconnect／stop 的狀態及錯誤歸屬符合已接收工作的完成邊界。建議優先級 **P1、有條件、small–medium effort／medium risk**：先用可控制的 deferred `onPosted` 或 queue admission 重現邊界，再決定是否 join 已接收的 acceptance。只等 durable admission，不能把整個 agent turn、工具或 deferred claim 一起卡在 socket 上；還需決定失敗傳遞與卡住時的取消／截止策略。最低測試：acceptance 未完成即 error+close，acceptance 成功與拒絕、重連後第二筆輸入順序、abort／stop、重複 post id，並觀察 connection promise、status、enqueue 與 dispatch 次數；確認 pre-open／pre-auth failure 不死等。現有 [WebSocket tests](../src/mattermost/monitor-websocket.test.ts) 與 [ingress tests](../src/mattermost/monitor-ingress.test.ts) 是 owning test 位置。

### B. 完整 registry 的路由／拒絕矩陣：值得借用測試方式

Discord 新增的是 adapter tests，明確區分 `/status` 直接路徑、`/model(s)` picker、args menu、普通 dispatch 與 plugin command，不把每個 command 強迫塞進相同分支；拒絕使用者不能在授權前讀 catalog 或產生 effect。[registry fixture][discord-registry]、[interaction boundary][discord-boundary]。

Mattermost 已用 [native-commands.ts](../src/mattermost/native-commands.ts) `buildMattermostNativeCommandSpecs` 動態列舉 core／skill／plugin，並在 [slash-http.ts](../src/mattermost/slash-http.ts) 驗證 token、sender、路由、skill filter；[native-commands.test.ts](../src/mattermost/native-commands.test.ts) 與 [slash-http.send-config.test.ts](../src/mattermost/slash-http.send-config.test.ts) 已涵蓋部分情境。因此**不是缺少 dynamic commands，也沒有從本次閱讀證明授權漏洞**。

建議 **P2、小型測試設計 port／low–medium risk**：在未來獨立工作中遍歷實際 registry，覆蓋允許／拒絕、room／thread／flat DM／threaded DM、root trigger／`oc_` fallback、技能 alias 與 plugin/core collision。驗證 session/thread identity 和 effect 邊界，不照抄 Discord private-thread 模型。使用本 repo standalone fixtures；mock adapter coverage 必須與 core command execution／provider discovery 的驗證分開。本次不新增或執行測試。

### C. 媒體 caption 的安全文字 fallback：先證明需求再做

Telegram `prepareTelegramOutboundMedia` 新開 `downgradeRichPromptTags`；`renderTelegramHtmlText` 只在該選項啟用時降級 authored rich tags，測試確認 code、已 escaped 內容和普通非-caption rendering 不變。[media][tg-media]、[format][tg-format]、[tests][tg-format-test]。

Mattermost [send.ts](../src/mattermost/send.ts) `renderMattermostMarkdown` 目前保留 native Markdown table，只依設定轉表格；同一 post 用 `message` 搭配 `fileIds`，沒有 Telegram HTML caption parser。[channel.ts](../src/channel.ts) 的 model hints 也未宣告 Telegram rich-tag 語法。這只能形成 **P3、有條件、small–medium effort／medium risk**：若真實 payload 證明 rich HTML tags 會裸露於 Mattermost 媒體文字，才設計最小 Markdown/plain fallback。不能全面 strip HTML、修改 literal code，或把 Telegram HTML escape 規則直接套進 Mattermost。最低測試為 nested list、checkbox、aside、entity／backslash escape、inline／fenced code、普通文字與既有 Markdown/table byte preservation，並檢查 text/media/recovery 路徑一致性；需 web/mobile 實際呈現才可宣告改善。

## 既有 backlog：10.6 重新核對的決策

這些是 [10.5 跨頻道研究](cross-channel-port-review-2026.10.5.md) 的延續，不計入新增 10.6 ports。優先順序是需求／成本判斷，並非已承諾實作。

| 候選／優先級 | 官方依據與 custom 實況 | 目前決策、effort／risk 與最低測試 |
| --- | --- | --- |
| **Silent send／P2** | Telegram outbound 將 `silent` 傳至 text/media/poll `disable_notification`。[adapter][tg-outbound]、[text][tg-send-text]、[media sender][tg-send]、[poll][tg-poll]。本地 [send.ts](../src/mattermost/send.ts) `MattermostSendOpts` 沒有 silent；[client.ts](../src/mattermost/client.ts) `isMessagePost` 仍是 exact `path === "/posts"`。 | **仍有效。** 收益是安靜排程／中間進度。沿用舊研究的 Mattermost 12 `?silent=true` provider 前提，實作前再核對目標 server 權限與通知語意；不能假裝任意 props 等價。small–medium／medium：query 不能繞過 dispatch evidence、unknown-send reconciliation 或 accepted-without-id 分類。測 ordinary/silent text/media、無選項預設、失敗／模糊回應、hook/receipt、approval/question 通知策略。 |
| **每 room／sender tool policy／P2** | [Discord resolver][discord-policy]、[Telegram resolver][tg-policy] 使用 scope policy。本地 [config-schema-core.ts](../src/config-schema-core.ts) 明確 omit `tools`／`toolsBySender`，[channel.ts](../src/channel.ts) groups 只有 mention resolver；skills 不是 tool policy。 | **仍有效，但舊提案不應預設必須自訂 resolver。** host [resolveGroupToolPolicyOutcome][tool-policy] 已先問 plugin 再 fallback flat groups。先證明 schema/type exposure＋host fallback 是否足夠。medium／medium–high：測 account/exact room/wildcard、stable sender、`senderPolicyMode`、scheduled/direct context、global deny 不能被 room allow 擴權，須通過真 tool selection。 |
| **Explicit old-file download／P2–P3** | Slack `downloadSlackFile` 刷新 metadata 並證明 channel/thread share，action 先做 read authorization。[download][slack-download]、[action][slack-download-action]。本地 [thread-tool.ts](../src/mattermost/thread-tool.ts) 回 metadata，[reference-media.ts](../src/mattermost/reference-media.ts) 已自動取當前／授權 reference files；[channel.ts](../src/channel.ts) actions 沒有 download-file。 | **只缺顯式舊檔 action，不能再提「新增 reference media」為缺口。** 發現歷史附件後可按需下載。medium／high authority risk：先從授權 post 證明 `file_id`、channel/root、sender/context visibility，再走 trusted saver／size/deadline/SSRF guards；file id 或 bot membership 本身不足。測 foreign channel/DM、deleted post/file、size/time/cancel、metadata-only read 不自動下載。 |
| **Top-level room history／P3** | Slack `resolveSlackRoomHistory` 取 authoritative channel/thread history，再套 sender、visibility、currentness 與 bounds。[history][slack-history]。本地 [monitor-posts.ts](../src/mattermost/monitor-posts.ts) 僅有 effective thread root 才 `recoverThread`；room `channelHistories` 是記憶體 map。 | **仍有效，限重啟後新 top-level room turn 的平台補史。** 不是 durable transcript／spool 遺失。medium／medium–high：用 [client.ts](../src/mattermost/client.ts) channel-post helper；測 restart/new mention、current/debounce IDs 去重、future/deleted/bot card 排除、allowlist/context visibility、ordering/limit/abort/session incarnation。 |
| **Inbound edit/delete awareness／P3** | Slack `resolveSlackMessageSubtypeHandler` 將 change/delete 分類、選 sender/thread 及 dedupe key。[handler][slack-subtypes]。本地 [monitor-websocket.ts](../src/mattermost/monitor-websocket.ts) 只處理 reaction 和 posted，忽略其餘 event；既有 edit/delete **outbound action** 不等價。 | **仍有效，需明確事件語意。** medium／medium–high：先做正確 session 的 bounded notice；檢查 sender/channel、忽略 bot streaming/card edits，處理 duplicate/reconnect、root/reply/deleted sender。Slack notice 不證明能改寫已消費 transcript、取消工作或自動重答；history replace/remove 需另外決策。 |
| **同 post 多附件／P3** | 本地 [channel.ts](../src/channel.ts) `resolveMattermostSendAttachmentMedia` 拒絕多 URL，[send.ts](../src/mattermost/send.ts) 只組 `[fileInfo.id]`。**修正舊依據：** Discord [sendDiscordOutboundPayload][discord-payload] 的 collection 走 `sendPayloadMediaSequenceOrFallback`／逐 media send，不能拿它當一般「單 post grouped files」已實作證據。 | **Mattermost 原生 `file_ids[]` 的需求仍可成立，但不是直接 Discord feature port。** 現有普通 reply 會逐檔送，不能說完全不支援多媒體。medium／medium–high：確認 provider count/aggregate size，先上傳再 create、部分 upload 失敗／orphan 清理，測順序、caption、單檔相容、SSRF/local roots、accepted-without-id 不盲重送。 |
| **完整 thread/work-session binding／P4** | [SDK factory][factory] 已預設 `supportsCurrentConversationBinding: true`，本地 [channel.ts](../src/channel.ts) 使用 factory，且有 `resolveDeliveryTarget`／outbound route，不能宣稱完全沒有 binding。Discord 有專用 [binding adapter][discord-binding]；Telegram [channel bindings][tg-binding]、Slack [configured bindings][slack-binding] 另有 native identity/config matching。 | **仍是完整 adapter/lifecycle 候選，非新增旗標就完成。** 本地 [monitor-event-plan.ts](../src/mattermost/monitor-event-plan.ts) 走 channel route，再由 [monitor-context.ts](../src/mattermost/monitor-context.ts) 派生普通 thread session；需追完整 host routing 才承諾 focus／ACP/child placement。large／high：account/channel/root、current vs child、unbind/reset、restart restore、idle/max age、stale delivery authority；只使用 published binding service，不複製核心 store。 |

較後順位的 native sections／tables／charts 和 durable team polls 仍應獨立評估。[normalize.ts](../src/normalize.ts) 已有 presentation fallback/buttons/select，[form-tool.ts](../src/mattermost/form-tool.ts) 是 transient host question，不能宣稱缺所有 rich UI，也不能當成跨重啟多人投票。Telegram rich caption 修正沒有提供 Mattermost rich layout renderer 或 poll persistence；本次不擴充這兩項需求。

## Sunset 決策：哪些必須留下

10.5 audit 中已排入目前 dirty 工作樹的 inert browser／Control UI accessory、ConversationLink producers 與 doctor import 清理，**保留現況，不重做、不復活，也不將它們算成這次新增移除**。[10.5 audit](porting-audit-2026.10.5.md)、[doctor-contract.ts](../src/doctor-contract.ts)。10.6 [store-entry-shape][entry-shape] 仍剝除 `conversationLink`；[session-entry-projection][projection] 仍隱藏 `lastRunId`，兩檔對 10.5 皆 byte-identical。origin shortcut 沒有恢復；本地 [monitor-turn.ts](../src/mattermost/monitor-turn.ts) 仍有 public entry `lastRunId` 讀取，屬已知 interface/source risk，沒有本次 live failure 證據，不能聲稱 10.6 已修復或用 cast 當 migration。

| 必須保留的 downstream family | 為何還不能 sunset／本地 owning files |
| --- | --- |
| Mattermost 12 長文／model hints、native/mobile forms | 官方 Mattermost runtime 未變；262,144/16,383 探測及 native/mobile controls 仍是 downstream contract。[text-limits.ts](../src/mattermost/text-limits.ts)、[capabilities.ts](../src/mattermost/capabilities.ts)、[question-dialog.ts](../src/mattermost/question-dialog.ts)、[form-tool.ts](../src/mattermost/form-tool.ts)。 |
| 動態 slash、root-first collision、channel model／runtime picker、group instructions/skills | Discord tests 或 shared registry 不會替 Mattermost 註冊、認證、選 root/session、讀回模型設定。[native-commands.ts](../src/mattermost/native-commands.ts)、[slash-http.ts](../src/mattermost/slash-http.ts)、[channel-model-command.ts](../src/mattermost/channel-model-command.ts)、[monitor-model-picker.ts](../src/mattermost/monitor-model-picker.ts)、[group-context.ts](../src/group-context.ts)。 |
| Status/ack reactions、activation/thread participation | 平台 emoji、steer correlation、mention-prefixed commands、bot-root thread mention policy 與重啟 participation 仍需 adapter。[monitor-turn-reactions.ts](../src/mattermost/monitor-turn-reactions.ts)、[monitor-activation.ts](../src/mattermost/monitor-activation.ts)、[thread-participation.ts](../src/mattermost/thread-participation.ts)。 |
| Signed callback／approval／secret／question、durable replay | host canonical resolver 不替代 signed current-control admission、stable owner/channel authority、secret 不入訊息／queue 的保護。[interactions.ts](../src/mattermost/interactions.ts)、[interaction-ingress.ts](../src/mattermost/interaction-ingress.ts)、[secret-dialog.ts](../src/mattermost/secret-dialog.ts)、[question-rpc.ts](../src/mattermost/question-rpc.ts)。 |
| SQLite spool、backlog debounce、delivery ambiguity／effect fencing | shared ingress log improvement 不提供 third-party queue ownership；Slack relay fix 也不替代 Mattermost signed markers、unknown/accepted-without-id 區分。[ingress-queue.ts](../src/mattermost/ingress-queue.ts)、[monitor-ingress.ts](../src/mattermost/monitor-ingress.ts)、[inbound-buffer.ts](../src/mattermost/inbound-buffer.ts)、[client.ts](../src/mattermost/client.ts)、[send.ts](../src/mattermost/send.ts)。 |
| Durable plan cards、late-plan handoff、yield/child continuation、restart/thread recovery | 必須維持 card 早於 result；commentary 已建 post 時 copy successor 再移交舊 identity；未接受 copy failure 與 accepted-without-id 不同；final 繼續 successor。host fix 沒有實作 Mattermost post identity contract。[draft-stream.ts](../src/mattermost/draft-stream.ts)、[task-progress-card.ts](../src/mattermost/task-progress-card.ts)、[monitor-progress-continuation.ts](../src/mattermost/monitor-progress-continuation.ts)、[restart-recovery-progress.ts](../src/mattermost/restart-recovery-progress.ts)。 |
| Reads/search、permalink/reference media、verified thread move | retired UI origin metadata 不等於 live post permalink；保留 bounded/read authorization、media saver、copy-verify-delete。[search.ts](../src/mattermost/search.ts)、[permalink-hydration.ts](../src/mattermost/permalink-hydration.ts)、[reference-media.ts](../src/mattermost/reference-media.ts)、[thread-move-command.ts](../src/mattermost/thread-move-command.ts)。 |
| Standalone artifact seams、SDK facades／doctor compatibility | 沒有本地 consumer 不代表 root artifact export 無外部 consumer；現有 migration/config/callback compatibility 不因版本更新自動過期。[build-runtime.mjs](../build-runtime.mjs)、[vitest.config.ts](../vitest.config.ts)、[runtime-api.ts](../runtime-api.ts)、[doctor-contract.ts](../src/doctor-contract.ts)。 |

## SDK／core 所有的 10.6 改善與 migration 前置

| 改善 | 對本 plugin 的意義及界線 |
| --- | --- |
| `createTypingKeepaliveLoop` timer rejection catch | [SDK source][typing] 新增 catch＋warning 並繼續 loop；explicit `tick()` 仍 reject。本地 [restart-recovery-progress.ts](../src/mattermost/restart-recovery-progress.ts) `startTyping` 已用 shared helper，且 callback 本來自行 try/catch，不能稱為已證實本地 unhandled rejection 修復。未來升級 helper 可取得共用保護；不刪 recovery typing。 |
| Ingress claim refresh error 可觀測 | [drain][drain] 現在 log failed refresh 並 hold claim；[monitor-ingress.ts](../src/mattermost/monitor-ingress.ts) 已把 `onLog` 交給 shared monitor → drain。這是 SDK 升級收益，並非本地另加 refresh loop 或移除 queue。 |
| Direct status worker read／private snapshot | [resolveDirectStatusReplyForSessionCore][status] 改 await read-only worker，clone model-selection inputs 並不給 persistence path，避免查 status 修改 pins。custom slash 走自己的 routed dispatcher，未發現直接消費此 API；保留為 core/SDK-owned，不能宣稱 custom `/status` 已獲同一條路徑保證。 |
| 新 `path-existence-runtime`、provider reasoning export | [path helper][path-existence] 僅轉出 `lstatIfExists`；[provider-stream-shared][provider-stream] 增 provider reasoning export。沒有已證實的 Mattermost 缺口或必要 import migration。 |
| Test runtime export／cold import timeout | [plugin-test-runtime][plugin-test] 增 registry cleanup export；[direct-smoke][direct-smoke] 調整 monorepo cold import timeout。不是 public standalone tests 授權，不改本 repo exclusions／fixtures。 |

未來若另立 10.6 adaptation，先滿足以下條件；本次未執行：

1. **先核對實際部署目標 Node。** 官方與 published npm `engines.node` 為 `>=24.22.1 <25 || >=26.12.1`。[package][node-engine]。目前 live Gateway runtime 未查核；不能因 semver 是 Node 26 就假設符合，也不能在本研究升級 runtime。TLS/runtime security 前提屬 host 部署工作。
2. 本地 [package.json](../package.json) 仍鎖 development SDK `2026.10.5`、min host／plugin API `>=2026.10.5`。未來才在獨立 scope 更新並檢查 exact published 10.6 artifact 的 emitted SDK subpaths、named exports、external deps 與 capability manifest diff；export map 無移除不等於 build／TypeScript 已通過。
3. Async session-read／窄化 deprecated facades 是具 caller 影響的 migration；10.6 沒有用共同 helper 抹掉本地同步 caller 的必要性。保留現有 facade／legacy consumer，按實際 import 和外部 artifact contract 逐項處理。[10.5 audit](porting-audit-2026.10.5.md)、[runtime facade](../src/mattermost/runtime-api.ts)。
4. core 的 restart custody、transcript、worker、stop/steer、scheduled authority 等改變以官方 changelog 為追蹤入口，交由 host owner 驗證；這裡不承諾其 runtime effect，也不從 changelog 將 Telegram album 等項目當成本輪 extension 內新增能力。[changelog][changelog]。

## 未來 validation 計畫與本次證據界線

任何被接受的 port，先完成上面該項最小 regression，再依 [AGENTS.md](../AGENTS.md) 跑 standalone narrow suite、full Vitest 和 build；不要用 OpenClaw source checkout 替換 published dependency、不要抄 monorepo-only test subpaths。這次只有 source／document 檢查，**沒有 compatibility pass、build pass、test pass 或 live acceptance claim**。

安裝與 restart 需另有明確授權。屆時先檢查 active sessions／long work、self-contained artifact、managed install tree／record／payload 與 capability/config diff；restart 後核對 Gateway/plugin/Mattermost health，再用全新 inbound turn 證明行為。涉及 cards 必須覆蓋「result delivery 已開始但尚無 post」及「commentary 已有 visible post」兩邊界；量測 `task_progress`／`turn_result` 建立順序、API call sequence／identity ownership、後續 tool/final 所在 successor、terminal card 真實狀態與 planless turn 不建 card。恢復舊 turn 不能代替 fresh inbound smoke。[本地驗收規範](../AGENTS.md)、[目前 lifecycle contract](../README.md)。

本次只准新增本文件。原始 271-entry manifest（含已刪除 path）／status／binary diff，以及更廣的既存檔案 hash snapshot，於交付時重新比較；來源保全與引用／anchor 檢查結果保存在外部 `RESULT.md` 及 JSON receipts。本地既有測試與 README 的歷史通過敘述只作背景，不重新背書；官方 tests 的 assertions 是閱讀證據，未在這裡執行。

[compare]: https://github.com/openclaw/openclaw/compare/v2026.10.5...v2026.10.6
[release]: https://github.com/openclaw/openclaw/releases/tag/v2026.10.6
[commit]: https://github.com/openclaw/openclaw/commit/fe06181dc5ecc01cf8904abbfc26925925efefbc
[package]: https://github.com/openclaw/openclaw/blob/v2026.10.6/package.json#L1
[node-engine]: https://github.com/openclaw/openclaw/blob/v2026.10.6/package.json#L2388
[changelog]: https://github.com/openclaw/openclaw/blob/v2026.10.6/CHANGELOG/2026.10.6.md#L1
[mm-package]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/mattermost/package.json#L1
[slack-package]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/slack/package.json#L1
[discord-package]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/discord/package.json#L1
[tg-package]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/package.json#L1
[slack-rich]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/slack/src/rich-text.ts#L78
[slack-content-test]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/slack/src/monitor/message-handler/prepare-content.test.ts#L22
[slack-provider]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/slack/src/monitor/provider-support.ts#L29
[slack-relay]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/slack/src/monitor/relay-source.ts#L164
[slack-relay-test]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/slack/src/monitor/relay-source.test.ts#L221
[discord-boundary]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/discord/src/monitor/native-command.interaction-boundary.test.ts#L252
[discord-registry]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/discord/src/monitor/native-command.plugin-dispatch.registry.test-support.ts#L58
[discord-realtime]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/discord/src/voice/realtime-session.runtime.ts#L92
[discord-voice-delivery]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/discord/src/voice/voice-session.ts#L505
[discord-voice-test]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/discord/src/voice/realtime-text-fallback.test.ts#L25
[tg-network]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/src/network-config.ts#L23
[tg-fetch-test]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/src/fetch.test.ts#L329
[tg-format]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/src/format.ts#L307
[tg-media]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/src/outbound-media.ts#L66
[tg-format-test]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/src/format.test.ts#L472
[tg-outbound]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/src/outbound-adapter.ts#L313
[tg-send-text]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/src/send-message-text.ts#L247
[tg-send]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/src/send-message.ts#L317
[tg-poll]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/src/send-special.ts#L126
[discord-policy]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/discord/src/group-policy.ts#L97
[tg-policy]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/src/group-policy.ts#L69
[tool-policy]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/agents/agent-tools.policy.ts#L594
[slack-subtypes]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/slack/src/monitor/events/message-subtype-handlers.ts#L5
[discord-payload]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/discord/src/outbound-payload.ts#L206
[slack-history]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/slack/src/monitor/message-handler/prepare-room-history.ts#L22
[slack-download]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/slack/src/actions.ts#L611
[slack-download-action]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/slack/src/action-runtime.ts#L829
[factory]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/plugin-sdk/core.ts#L723
[discord-binding]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/discord/src/thread-bindings-channel.ts#L1
[tg-binding]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/telegram/src/channel.ts#L639
[slack-binding]: https://github.com/openclaw/openclaw/blob/v2026.10.6/extensions/slack/src/channel.ts#L477
[entry-shape]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/config/sessions/store-entry-shape.ts#L29
[projection]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/config/sessions/session-entry-projection.ts#L15
[typing]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/channels/typing-lifecycle.ts#L27
[drain]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/channels/message/ingress-drain.ts#L228
[status]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/plugin-sdk/command-status.runtime.ts#L39
[ingress-monitor-admission]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/channels/message/ingress-monitor.ts#L572
[ingress-monitor-stop]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/channels/message/ingress-monitor.ts#L683
[path-existence]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/plugin-sdk/path-existence-runtime.ts#L1
[provider-stream]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/plugin-sdk/provider-stream-shared.ts#L30
[plugin-test]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/plugin-sdk/plugin-test-runtime.ts#L165
[direct-smoke]: https://github.com/openclaw/openclaw/blob/v2026.10.6/src/plugin-sdk/test-helpers/direct-smoke.ts#L38
