# OpenClaw 2026.10.4 跨 channel 移植評估

研究日期：2026-10-16。比較官方 `v2026.10.3` 與 `v2026.10.4` 的完整
source archives，再對照目前 standalone Mattermost plugin。這份評估包含
10.4 的新增差異，以及先前已有、目前仍值得移植的能力。

後續實作狀態：依使用者指示，已移植第一項的 model/runtime 確認流程，以及
Telegram backlog-aware debounce 的等價文字批次策略。附件部分經 git history
再次核對，`093b0ee` 已移植 referenced media hydration，`f6e34ef` 改為預設開啟；
原評估的「缺口」僅指額外的 on-demand action，並非附件下載完全未移植。
這次保留既有 reference media，不新增另一套下載介面。

## 結論與建議順序

| 優先度 | 來源與候選 | Mattermost 的實際價值 | 工作量與決策 |
| --- | --- | --- | --- |
| 1 | Discord：模型與 runtime 選單 | 從原生選單一起選模型及執行 runtime，免手打 `--runtime`；套用後顯示實際生效結果。 | 已移植；沿用現有 callback 保護及 host model-selection API。 |
| 2 | Slack：按需讀取舊附件 | 額外提供讀過 thread metadata 後指定附件的工具能力。現有 referenced media hydration 已移植。 | 本次不擴充；保留既有引用下載。 |
| 條件式 | Telegram：知道 ingress backlog 的訊息合併 | quiet flush 前查看 durable lane backlog，等待尚未交給 buffer 的同 sender/thread 文字。 | 依使用者指示已移植；保留 SDK deadline，另限制 12 posts／50,000 字元。 |
| 暫緩 | Discord：持久 thread／ACP worker bindings | 讓 thread 長期對應子工作／ACP session，而非一般 reply routing。 | 高。先有 Mattermost thread-as-worker 使用案例，再設計持久化與回收。 |

前兩項在先前版本已存在，**不是 10.4 新增**。這次重新確認它們仍是本地缺口。
先前移植的 deferred ingress lane release 與 session 來源連結已存在，不重複列為待辦。
先前評估見 [`cross-channel-2026.10.1.md`](cross-channel-2026.10.1.md)。

## 10.4 新增差異的判斷

完整 archive 比較結果：

| 比較範圍 | 檔案數 | 10.3 → 10.4 |
| --- | --- | --- |
| `extensions/discord` | 744 | 只有 `package.json` |
| `extensions/slack` | 435 | 只有 `package.json` |
| `extensions/telegram` | 520 | `package.json`、ingress worker 及其測試 |
| `extensions/mattermost` | 150 | 只有 `package.json` |
| `src/plugin-sdk` | 729 | byte-identical |
| `src/channels` | 537 | byte-identical |

這個結論限於上表的 source trees，不能推論整個 host 或 Discord 行為完全沒變。
例如 release notes 的 Discord voice change 後 consult context 修正
[#171029](https://github.com/openclaw/openclaw/pull/171029)
位於 core voice-selection control；應隨 host 升級取得，不需要在 Mattermost 加上
語音 callback workaround。

來源：
[10.3 Discord](https://github.com/openclaw/openclaw/tree/v2026.10.3/extensions/discord)、
[10.4 Discord](https://github.com/openclaw/openclaw/tree/v2026.10.4/extensions/discord)、
[10.3 Slack](https://github.com/openclaw/openclaw/tree/v2026.10.3/extensions/slack)、
[10.4 Slack](https://github.com/openclaw/openclaw/tree/v2026.10.4/extensions/slack)、
[10.3 Telegram](https://github.com/openclaw/openclaw/tree/v2026.10.3/extensions/telegram)、
[10.4 Telegram](https://github.com/openclaw/openclaw/tree/v2026.10.4/extensions/telegram)、
[release notes](https://github.com/openclaw/openclaw/releases/tag/v2026.10.4)。
Archive identities、雜湊及 SDK 驗證記錄見
[`upstream-2026.10.4.md`](upstream-2026.10.4.md)；比較 receipts 保留在
`/tmp/openclaw/mattermost-2026-10-4`。

## 1. Discord 的模型與 runtime 選單

Discord 的
[`model-picker.view.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/discord/src/monitor/model-picker.view.ts)
依 provider/model 取得 runtime choices、保留明確的 pending runtime，並要求有效選擇。
[`native-command-model-picker-interaction.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/discord/src/monitor/native-command-model-picker-interaction.ts)
在提交前重新確認該 runtime 仍適用於目前模型。
[`native-command-model-picker-apply.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/discord/src/monitor/native-command-model-picker-apply.ts)
則在 host 接受後讀回實際 model/runtime，區分成功、拒絕、timeout 與 mismatch，
不把「dispatch accepted」直接當成設定成功。

研究時本地 [`monitor-model-picker.ts`](../src/mattermost/monitor-model-picker.ts)
只送出 `runtime: { kind: "unchanged" }`；
[`model-picker.ts`](../src/mattermost/model-picker.ts) 提示使用者手打
`/oc_model <provider/model> --runtime <runtime>`。因此值得借的是 runtime 選擇、
提交前驗證和結果讀回，而非重做整套 picker。Discord 的 model token／label
長度規則也不必照搬：本地已有 hash action ID，完整 model ID 保留在 callback context。

建議的最小範圍：

- 在現有原生 picker 顯示目前 runtime、host 提供的可用選項及明確的套用動作。
- 瀏覽模型時不自動切 runtime；無效或消失的選項要求重新選擇。
- 由 host 驗證、持久化，再讀回實際 model/runtime 回覆使用者。
- 保留 opener 身分、signed callbacks、replay admission 與既有 scope 行為。

驗收涵蓋：長 model ID、catalog 熱更新、runtime 選項變動、非 opener 點擊、
host 拒絕／timeout，以及持久狀態讀回。已安裝的 published 10.4 SDK 有
`models-provider-runtime` 的 `getModelsRuntimeChoices` 與 `model-session-runtime`
的 `applySessionModelSelection`；實作時仍須驗證實際使用的 exports 和 request contract，
不引入 monorepo-only imports。

## 2. Slack 的按需附件讀取

Slack
[`channel-actions.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/slack/src/channel-actions.ts)
宣告 `download-file`；
[`action-runtime.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/slack/src/action-runtime.ts)
先授權 channel target，再套用 thread、大小限制與圖片尺寸設定。
[`actions.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/slack/src/actions.ts)
取得 fresh file metadata，證明 file 屬於指定 channel／thread，並把相同檢查交給
media resolver，讓下載 URL 刷新後也重新驗證範圍。
[`actions.download-file.test.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/slack/src/actions.download-file.test.ts)
涵蓋 wrong channel、wrong thread、缺少 scope proof，以及 metadata 刷新後的再驗證。

本地 [`thread-tool.ts`](../src/mattermost/thread-tool.ts) 只回傳訊息及附件 metadata；
[`reference-media.ts`](../src/mattermost/reference-media.ts) 會自動處理一個已授權 reference，
但不能讓 agent 在閱讀歷史後按需取回其他附件。
[`channel.ts`](../src/channel.ts) 也沒有 `download-file` action。這是明確的功能缺口。

建議的最小範圍：

- 讓 agent 指定 post/file，讀取目前 account／instance／conversation 內的較早附件。
- 重新取得 post 及 file metadata，驗證 channel、必要時的 thread membership、
  post 的 `file_ids` 與 file/post 身分；不以 bot 可存取或知道 file ID 代替授權。
- 沿用 trusted media saver、大小與 timeout 預算、圖片尺寸處理；
  取得新 metadata 或 redirect 後仍維持同一個授權範圍。
- 對刪除、無法存取、超限或 metadata 不符提供可理解的結果。

特別注意本地 [`read.ts`](../src/mattermost/read.ts) 的授權差異：
`isCurrentMattermostReadTarget` 驗證目前 provider/account/native channel；
`isMattermostThreadTargetAllowed` 還允許其他已設定的公開 channel。新增下載功能
不能直接把後者當作「目前對話」檢查。若工具 context 限於 thread，還要驗證
post 屬於該 thread。這個範圍是本評估建議的第一版限制，不宣稱 Slack 所有
read action 本身都只允許 current conversation。

驗收涵蓋：跨 account／instance／channel／thread 拒絕、post/file 不符、
fresh metadata 範圍改變、大小／timeout／圖片尺寸，以及可正常讀取較早附件。
第一版只提供讀取能力，不順便擴大搜尋或跨 channel 存取範圍。

## 3. Telegram：條件式借鑑，沒有立即 port 的修正

10.4 的
[`telegram-ingress-worker.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/telegram/src/telegram-ingress-worker.ts)
改用 `resolveRuntimeWorkerUrl`／`resolveRuntimeWorkerArgv`，處理 source、
package dist 與 TypeScript preload；
[`測試`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/telegram/src/telegram-ingress-worker.test.ts)
驗證 source worker entry 及 `tsx` preload。
本地 [`monitor-websocket.ts`](../src/mattermost/monitor-websocket.ts) 直接使用 WebSocket，
[`ingress-queue.ts`](../src/mattermost/ingress-queue.ts) 在程序內使用 SQLite，
沒有 provider-owned Worker 的載入路徑。現階段不移植；未來若拆 worker 再參考。

這次移植的是既有
[`bot-handlers.inbound-buffer.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/telegram/src/bot-handlers.inbound-buffer.ts)
在 forwarded burst 的 quiet flush 前查看 `readLaneBacklogUpdates`，避免 spool
仍有同 sender／chat 輸入時過早拆批。本地
[`monitor.ts`](../src/mattermost/monitor.ts) 接上
[`inbound-buffer.ts`](../src/mattermost/inbound-buffer.ts)，沿用
account/channel/thread/sender 分組及系統訊息、附件 post、控制命令的排除規則。
quiet flush 只等待同 key、可加入目前批次的 durable backlog；不等待已在 buffer 的
claim、其他 account 或不同 provider。另採用 Telegram 文字批次的
12 posts／50,000 字元界限。
[`inbound-buffer.test.ts`](../src/mattermost/inbound-buffer.test.ts) 驗證 reader
停滯／失敗、deadline、scope 隔離與控制命令順序；
[`monitor-ingress.lane.test.ts`](../src/mattermost/monitor-ingress.lane.test.ts)
使用真實 published SDK 及 SQLite spool，驗證 B 已被 claim 尚未交給 buffer 時，
A 不提早 flush，兩筆一起採用並保留 completed tombstone。

這不是「Mattermost debounce 沒有等待上限」的缺陷：
共用 [`inbound-debounce.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/src/auto-reply/inbound-debounce.ts)
已預設以 debounce window 的五倍限制最大等待。Telegram 的
[`album collection`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/telegram/src/bot-handlers.inbound-media.ts)
另有多 update 的相簿語意；Mattermost 一個 post 已帶 `file_ids[]`，不需要照搬 album timer。

## 已覆蓋與暫緩事項

- Deferred ingress lane release 已在本地
  [`monitor-ingress.ts`](../src/mattermost/monitor-ingress.ts) 接上；
  session 來源連結已在 [`conversation-link.ts`](../src/mattermost/conversation-link.ts)
  及 browser accessory 實作。不要把它們再次列成缺口。
- Mattermost 已有 durable task cards、晚到 plan 的 identity handoff、
  generation barriers、provider-confirmed delivery 與 accepted-without-id 保護；
  見 [`monitor-turn.ts`](../src/mattermost/monitor-turn.ts)、
  [`monitor-draft-delivery.ts`](../src/mattermost/monitor-draft-delivery.ts)、
  [`draft-stream.ts`](../src/mattermost/draft-stream.ts) 及相鄰測試。
  其他 provider 的 draft replacement 或 progress UI 不構成重寫理由。
- Telegram
  [`ingress supersede predicate`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/telegram/src/telegram-ingress-supersede.ts)
  保護設定／skill 命令之前的 pending input，只允許已授權的明確 abort/reset
  取消輸入。本地沒有相同 provider predicate，無須複製；可保留為 ingress 測試原則。
- Discord
  [`thread-bindings-channel.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/discord/src/thread-bindings-channel.ts)
  及 [`thread-bindings.lifecycle.ts`](https://github.com/openclaw/openclaw/blob/v2026.10.4/extensions/discord/src/monitor/thread-bindings.lifecycle.ts)
  涉及持久 binding、lifecycle、sweeper 及 reconciliation。
  一般 Mattermost thread routing/recovery 不是同一需求；目前先暫緩。

## 本次驗證範圍

核對官方原始碼、測試、本地 owning boundaries 及附件移植的 git history，
實作 model/runtime confirmation 與 bounded backlog-aware buffer。
manifest 與能力宣告不變。Standalone 全套 97 個檔案、1,204 項測試中，
1,203 項通過，既有 session-store 整合測試在高負載下超過 10 秒；
該檔單獨重跑 12 項全過。`npm run build` 通過，驗證 published 10.4 SDK
的 85 個 subpaths／261 個 named exports，並產出 self-contained browser asset。
安裝包為
`/tmp/openclaw/mattermost-2026-10-4/cross-channel-port/openclaw-mattermost-custom-2026.10.4.tgz`，
SHA256：`3b6b8f4d4b3f835c2d67da407a5f8c46c7ad7fac4fd6c44fa359db578caa1bbc`。

完整測試結束後再次補跑上述檔案，12 項全過，測試部分耗時 1.91 秒；
保留原有 timeout 與排除規則。原始全套逾時仍記錄於驗證 receipt，未宣稱
第一次全套執行全部通過。

使用者授權安裝後，透過 Herdr 讀取既有 OpenClaw 部署工作，再由 Gateway RPC
確認實際服務為 `2026.10.4`、當時沒有活躍請求或 session mutation，才安裝上述
archive。CLI exit 0，回報 `Applied in Gateway generation 3`。安裝後驗證：

- Managed install 的 36 個檔案與 archive 全數逐 byte 相同。
- 安裝紀錄版本及 runtime catalog 皆為 `2026.10.4`，custom plugin 為 active。
- 已接受能力宣告不變；custom owner 啟用、bundled Mattermost 未啟用。
- `channels.mattermost` 設定不變；設定 diff 僅 `/meta/lastTouchedVersion`。
- Mattermost account 為 `lifecycle=ready`、running、connected，`lastError=null`。
- Gateway PID 未變，本次安裝經 scoped runtime replacement 生效，沒有另行重啟。

完整證據位於上述 artifact 目錄的 `postinstall-verification.json`、
`installed-payload-verification.json`、`config-diff.json` 及 `validation-receipt.json`。
沒有 commit 或 push。

主程式仍有安裝前已存在的 agent database 背景啟動檢查及 autolearn host peer-link
問題，既有 Herdr 部署 agent 正在處理；通道 ready 不代表整體會話啟動全部正常。
10.4 適配原有的 standalone tests/build/pack 記錄見
[`upstream-2026.10.4.md`](upstream-2026.10.4.md)。
新增 lifecycle 行為仍需以新的 inbound turn 做 live smoke test；
截至安裝驗證時尚未收到新 inbound，不能以 source 測試或連線 ready 取代功能實測。
