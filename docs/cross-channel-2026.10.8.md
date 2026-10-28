# OpenClaw 2026.10.8 跨頻道移植研究

研究日期：2026-10-28。對照官方 10.7→10.8 的完整 Slack、Discord、Telegram
子樹，再檢查本次 release 提到的 Feishu、Google Chat、Synology Chat、Tlon。
本文只記錄原始碼研究；下列候選尚未實作，也不表示 live Mattermost 已發生缺陷。

## 結論

這次最值得借的是 **Feishu 的 assistant-message snapshot 邊界測試**和
**Telegram 的恢復重試 typing 清理測試**。兩者先在 Mattermost 真正的 monitor
邊界驗證，只有重現問題才修改 runtime。舊候選中，Discord 的背景 draft 合併
仍可用於 REST 預覽；companion 的 WebSocket 預覽已經啟用，不需重做。

Slack 新的 heartbeat 與暫時 auth failure 重試，Mattermost 已有對應保護。
各頻道的 implicit-default secret 修正已由本次
[Mattermost 10.8 適配](upstream-2026.10.8.md)涵蓋。沒有理由複製其他平台的
provider API、auth 錯誤字串或 receipt 格式。

## 比較範圍與證據

固定來源是官方 10.7 peeled commit
`157d8c2bc3ea2fa183afdc11088e69690bf8e64e` 與 10.8 peeled commit
`dc2523e5a5c7a309517fd7fa834add938231d526`。10.8 完整 tag archive SHA-256：
`42dc4a9f5f921c77487dd8c95e92d91c792187266a0b60cd15626b284674de9c`。
來源身分沿用[適配紀錄](upstream-2026.10.8.md)，不以 release 標題推測 source delta。

比較所有路徑、mode 和 Git blob identity，包含 tests、helpers、assets、metadata，
不是 GitHub compare API 的截斷清單。以下七個子樹共 2,179→2,181 檔，
50 個修改、2 個新增、0 個刪除；52 個變動檔的完整 patches 均已查閱。
所有 package 修改只提升版本、host peer、plugin API／build metadata。

| 官方子樹 | 10.7 | 10.8 | 修改 | 新增 | 刪除 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Slack | 421 | 422 | 8 | 1 | 0 |
| Discord | 730 | 730 | 2 | 0 | 0 |
| Telegram | 505 | 505 | 3 | 0 | 0 |
| Feishu | 293 | 293 | 10 | 0 | 0 |
| Google Chat | 96 | 96 | 10 | 0 | 0 |
| Synology Chat | 44 | 44 | 8 | 0 | 0 |
| Tlon | 90 | 91 | 9 | 1 | 0 |

完整 manifest、舊／新變動檔與 patches：
`/tmp/openclaw/mattermost-adapt-2026.10.8/cross-channel/`；
後四個 channel 位於其 `extra-channels/`。獨立讀者的 custom 邊界筆記為
`custom-boundaries.md`。本次不是所有 OpenClaw extension／core 的全面稽核。

## 10.8 新變更的適用性

| 來源與實際變更 | Mattermost 判斷 |
| --- | --- |
| Slack `monitor/{provider,provider-support,reconnect-policy}.ts` 與 reconnect tests/helper：孤立的 `invalid_auth` 最多連續三次才 terminal；成功連線歸零，明確 revoked 等錯誤仍 terminal。[source][slack-auth] | 不照搬錯誤分類。Mattermost 使用自己的 challenge/OK 協定；API auth 失敗與 pre-auth close 已重試。此查核沒有找到單次 auth failure 即停用的等價缺口。 |
| Slack `relay-source.ts` 新增 `startWebSocketKeepalive`，新增真實 socket 的 responsive／silent-peer liveness test。[source][slack-relay]、[test][slack-liveness] | 已有 30 秒 ping、10 秒 pong deadline、30 秒 auth deadline、bot `update_at` 健康檢查。既有 `monitor-websocket.test.ts` 覆蓋 pong 持續與 timeout；無需再加一套 heartbeat。 |
| Slack、Telegram、Google Chat secret collector 保留 implicit default；Discord 改用共用 account-surface resolver。[Slack][slack-secret]、[Telegram][telegram-secret]、[Google Chat][google-secret]、[Discord][discord-secret] | 本次 Mattermost 適配已在自己的 account contract 修正，不再列為另一個 port。 |
| Telegram 只新增兩次 failed-retryable recovery 後停止 `sendChatAction` 的 HTTP regression；此 subtree 的 dispatch runtime 未變。[test][telegram-typing] | 可借測試情境，不是新的 Telegram typing runtime 實作。Mattermost 也交由 published host 管理 typing／ingress recovery，需驗證實際 API call 停止與再次啟動。 |
| Feishu `reply-dispatcher.ts` 使用明確 message-start 凍結較早文字、替換本訊息 snapshots，移除長度／重疊猜測，並啟用 callback start-order preservation；相關 dispatcher、delivery trace、stream tests 更新。[source][feishu-dispatch]、[trace][feishu-trace] | 最值得借的新增模式。Mattermost 已啟用 start-order preservation，block mode 亦有 generation boundary；不能整份替換。應先測工具前後文字、短 snapshot 修訂、final identity，見候選表。 |
| Feishu Card JSON 2.0 把 legacy action row 換成 column-set；approval/launcher tests 實際點擊產生的 button。[source][feishu-card] | Card schema 是 Feishu 專用。可參考 emitted-button round trip 的測試方法，不把 provider card JSON 搬進 Mattermost。 |
| Google Chat actions、outbound adapter、format、monitor delivery 及 tests：service-account channel 把 HTTP(S) 附件轉成文字連結，拒絕本地／非 web media。[formatter][google-format]、[delivery][google-delivery] | Mattermost 已有真正上傳與有序多附件。自動改送連結會改變隱私、可讀性與 delivery 語意，不列入此次 port；若另有使用者需求，再定義明確 link-only 操作。 |
| Synology Chat client/channel 及 tests：只將 requested-recipient 對應的有效 post IDs 記成 receipts，所有 physical chunks 有 identity 才確認 aggregate；inbound event 適配新 result shape。[client][synology-client]、[adapter][synology-channel] | Mattermost 已有真實 post receipts、unknown-send reconciliation 和 accepted-without-id 邊界。保留既有能力，不複製 Synology webhook response parser。 |
| Tlon monitor/ingress/utils/SSE client 及 tests：SSE network stall watchdog、bounded recursive rich-text extraction、不可序列化 poison event 的永久 drop／ack。[SSE][tlon-sse]、[ingress][tlon-ingress]、[renderer][tlon-utils] | SSE heartbeat／Urbit ack 與遞迴 rich-text tree 屬平台特性。Mattermost 已有 WebSocket keepalive，durable ingress 保存原始 event 字串，message text 也不是 Urbit inline tree。沒有證據支持套用 Tlon drop／ack 策略。 |

## 值得移植的下一批

優先級是後續實作排序，並非已確認 bug severity。

| 順序 | 候選／收益 | 現有邊界與最低驗證 |
| --- | --- | --- |
| 1 / P2 | **Feishu snapshot／工具邊界 regression**。避免工具後的新 assistant message 覆蓋較早文字，並核對合法修訂能否縮短 preview。成本 small–medium，identity 風險 medium。 | [`monitor-turn.ts`](../src/mattermost/monitor-turn.ts) 已用 `onAssistantMessageStart` reset；block activity 切換會 seal generation，並已傳 `preserveProgressCallbackStartOrder`。`updateDraftFromPartial` 仍忽略「新值是舊值較短 prefix」；這能防止舊 partial 倒退，也可能擋合法修訂，尚未證明 host 會送出該順序。先以真正 monitor callbacks 測 pre-tool partial／final、tool end、新 message-start、短／更正 partial、最後 final；在 REST 和 companion 確認可見全文、post identity／順序、late-plan handoff，不能僅刪 guard。 |
| 2 / P2 | **Telegram failed-recovery typing 清理 regression**。避免重試間隔或最終失敗後仍顯示輸入中。成本 small–medium。 | [`monitor-event-plan.ts`](../src/mattermost/monitor-event-plan.ts) 把 typing start 交給 published host；[`monitor-turn.ts`](../src/mattermost/monitor-turn.ts) 經 `core.channel.inbound.run`。使用已安裝的 published SDK 和 Mattermost transport spy／loopback，測兩次 prepared-runtime recovery failure、重試間無 typing、terminal 後停止、後續成功 turn 可重新啟動。不可把已存在的 session-admission retry helper 測試當成這項證明。 |
| 3 / P2，舊候選 | **Discord `coalesceInFlight: true` 用於 REST preview**。慢 REST 時保留下一個背景 throttle window，減少連續補發。成本 small，lifecycle 風險 medium。[Discord source][discord-draft]、[shared loop][draft-loop] | [`draft-stream.ts`](../src/mattermost/draft-stream.ts) 未設定該選項；[`companion-stream.ts`](../src/mattermost/companion-stream.ts) 已設 true，因此只評估 REST／fallback。用 deferred create/patch 驗證 latest-value retention、calls cadence、explicit final/boundary flush、abort/error、accepted-without-id 與 task-card successor handoff。尚無本輪 live 效能缺陷證據。 |
| 4 / P2，舊候選 | **預覽 Stop 按鈕**，手機不用輸入 `/stop`。成本 medium，authority 風險 high。參考 Slack 的授權後 stop admission。[handler][slack-stop] | 已有 native `/stop`，缺的是 preview control。現有 generic button 只是普通 inbound turn，不能當作 cancellation API。先證明 published host 可取消正確 authorized run/session incarnation，再設計 signed source/clicker 綁定、replay、final race、restart fencing。這不是 10.8 新增，也不是單純加 button 即完成。 |

前兩項應先建立能區分現行行為的 owning-boundary regression；測試通過即保留現有
runtime，不為「有 port」強加修正。若失敗，修復仍只在 Mattermost owning boundary。

## 舊研究需要減項

- **Slack reconnect ingress join 從 P1 port 降為條件式診斷。**
  [`monitor-websocket.ts`](../src/mattermost/monitor-websocket.ts) 沒有 per-socket
  pending-listener join，但 [`monitor.ts`](../src/mattermost/monitor.ts) 的 ingress
  跨 reconnect 存活；[`monitor-ingress.ts`](../src/mattermost/monitor-ingress.ts)
  的 receive await durable admission，stop 亦會 join。這不足以斷言 close 丟資料。
  只有 deferred admission／close／reconnect 的實際順序測試失敗才重開，且只 join
  durable acceptance，不等完整 agent run。
- **Agents-style bridge 從「研究可行性」移除。** 同 repo
  [`companion/`](../companion/README.md) 已有獨立 server/web artifact；
  [現行合約](companion-streaming-implementation.md)已有 WebSocket preview、
  REST checkpoints/final persistence。這不代表原生 mobile 已有相同 renderer。
- **Silent send、channel/sender tool policy、有序多附件、長訊息與 source-owned
  reactions 均已有。** 以 [README](../README.md) 的現行合約為準，不重複推薦。
- **Native footer 交由 core。** 不恢復已移除的 custom usage footer。
- Room-root history、明確下載舊附件、inbound edit/delete、完整 work-session binding
  仍屬[既有 backlog](cross-channel-2026.10.7.md)，本次未新增完整驗證；
  不以 10.8 metadata 升版當作完成或新的移植證據。

## 驗證界線

本次只新增本文。已核對七個 upstream 子樹的 manifests／所有變動檔與上述本地
owning sources，並確認先前 adaptation source hashes 未變；未新增 runtime、
依賴、設定或部署變更。沒有為研究文件重跑 tests/build/review。先前 10.8 適配
全套 111 files / 1,403 tests、build 與獨立 review 收據仍只證明該適配候選，
不證明本文待辦已實作、重現或 live acceptance。

原本七個未提交 adaptation paths 保留；本次也沒有 commit/push/install/restart、
peer-link、production config/DB 或 Mattermost message/reaction 寫入。
若後續實作 lifecycle port，依 repository 規則跑 focused/full standalone/build；
授權部署後另用新 inbound turn 驗證，不能用 source 測試替代。

## 後續實作：同日接受前三項

使用者後續授權實作上述前三項；先前各節保留研究當時的判斷。

- 新增 [`monitor-turn.streaming.test.ts`](../src/mattermost/monitor-turn.streaming.test.ts)，
  使用真正 Mattermost turn、event plan、draft、reply pipeline 和 published SDK
  buffered dispatcher；替換 host agent execution 與外部 transport。
  REST／companion 的工具前文字、後續 generation 和 cumulative final identity
  原本即通過，不另複製 Feishu renderer。
- 較短的同訊息 snapshot 在兩個 transport 都被舊 prefix guard 擋住；
  缺少 matching partial 的較短 final 也無法沿用 preview identity。四個 red
  regressions 分別證實後，移除這兩處長度猜測，沿用既有 callback start-order、
  generation fencing、final readback 與 source-bound delivery。
  隔離 probe 另重現 block mode 的 cumulative final 縮短目前段落時會重複封存前文；
  resolver 現在接受目前 draft 的非空 prefix 作為剩餘 final，仍保留既有
  sealed-prefix／newline 和其他不匹配內容的保守判斷。兩種 transport 均加 owning
  regression，確認較早 post 不變且 final 只修改 successor。
- 兩次模擬 prepared-runtime failure 後的 typing 清理原本即通過。測試經過
  published SDK dispatcher 和實際 Mattermost typing request builder，確認
  keepalive 已啟動、失敗後停止、重試間隔無呼叫、後續正常 turn 能再次啟動。
  此測試不是完整 Gateway recovery queue／自動重試或 live host 證明；
  不新增 plugin typing timer 或複製 core retry policy。
- 一個慢 REST create 後，背景新值原本會立即補發，沒有等待下一個 throttle
  window。先以 deferred create 重現，再啟用既有 SDK 的
  `coalesceInFlight: true`；另測 explicit flush／generation boundary
  不受背景等待影響。Companion snapshot loop 原本已有此選項，維持原樣。
- 本批 source gate、build 和獨立 review 的 exact-candidate 收據另存
  `/tmp/openclaw/mattermost-port-2026.10.8/`。前一批 adaptation 收據不代替本批
  驗證；本批也不包含 Stop 按鈕、commit/push、安裝或重啟。

[slack-auth]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/slack/src/monitor/reconnect-policy.ts
[slack-relay]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/slack/src/monitor/relay-source.ts
[slack-liveness]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/slack/src/monitor/relay-source.liveness.test.ts
[slack-secret]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/slack/src/secret-contract.ts
[telegram-secret]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/telegram/src/secret-contract.ts
[google-secret]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/googlechat/src/secret-contract.ts
[discord-secret]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/discord/src/secret-config-contract.ts
[telegram-typing]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/telegram/src/bot-message-dispatch.preview.telegram-http.test.ts
[feishu-dispatch]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/feishu/src/reply-dispatcher.ts
[feishu-trace]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/feishu/src/delivery-trace.test.ts
[feishu-card]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/feishu/src/card-ux-shared.ts
[google-format]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/googlechat/src/format.ts
[google-delivery]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/googlechat/src/monitor-reply-delivery.ts
[synology-client]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/synology-chat/src/client.ts
[synology-channel]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/synology-chat/src/channel.ts
[tlon-sse]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/tlon/src/urbit/sse-client.ts
[tlon-ingress]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/tlon/src/monitor/ingress.ts
[tlon-utils]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/tlon/src/monitor/utils.ts
[discord-draft]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/discord/src/draft-stream.ts
[draft-loop]: https://github.com/openclaw/openclaw/blob/v2026.10.8/src/channels/draft-stream-loop.ts
[slack-stop]: https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/slack/src/monitor/events/agent.ts
