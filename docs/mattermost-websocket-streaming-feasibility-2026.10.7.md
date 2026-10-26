# OpenClaw → Mattermost WebSocket 串流可行性

查核日期：2026-10-26。問題對應 [跨 channel 研究的第 3 項](cross-channel-2026.10.7.md)：
保留 OpenClaw 產生回覆，將目前逐次 REST edit 的預覽改成 Mattermost Agents 類型的暫態 WebSocket 更新。

## 判斷

**OpenClaw 可以供應所需串流，不需要修改 OpenClaw core；但只改這個 channel plugin，不能使原版 Mattermost web/mobile 接受新的 Agents 串流。**

這裡有兩條不同的實作路線：

| 路線 | 可行範圍 | 必要變更與限制 |
| --- | --- | --- |
| 保留 `mattermost-custom`，增加 Mattermost server/web companion | 可以保留目前 channel 的 session、權限、任務卡與互動流程，為 web 增加專用串流 | 需要另一個部署在 Mattermost 的 server plugin 和 web renderer；原版 mobile 沒有新 namespace 的專用 handler，需要保留 post edit fallback，或另做 mobile/Agents 整合 |
| Mattermost Agents → OpenClaw OpenAI-compatible SSE | 既有 Agents 負責 post、WebSocket、web/mobile，OpenClaw 作為上游 agent service；文字串流有對應公開介面 | 對話入口改由 Agents 管理；目前 channel 的來源身分、路由、任務卡、按鈕和審批不會自動移植。需要驗證 session 映射與權限，不能視為現有 plugin 的透明 transport 切換 |

第一條的判斷有 SDK、事件接收程式與本機實驗支撐；第二條是雙方公開介面相符的架構可行性，**尚未完成 Agents ↔ Gateway 的實際連線驗證**。
兩者都不能宣稱已完成正式環境端到端驗證。

## OpenClaw 的供應端已具備能力

已安裝的 published npm SDK 是 `openclaw@2026.10.7`。
公開 `openclaw/plugin-sdk/reply-runtime` 匯出的 `GetReplyOptions` 包含：

- `onPartialReply`：可取得完整累積文字，也容許 replacement；不能把 `text` 再當 delta 反覆 append。
- `onReasoningStream` / `onReasoningEnd`、`onToolStart` / `onItemEvent`、`onPlanUpdate`。
- `onAgentRunStart`、`abortSignal`，以及 callback 開始順序控制。

SDK 的公開 adapter 只移除 core 專屬的 `internalEventExecution` 與 `onReplyOperationOwned`，
不會移除這些 channel callback。[公開型別][oc-options]、[公開 adapter][oc-public-options]。
core presentation 實際呼叫 `onPartialReply`；embedded 路徑提供惰性讀取的累積、清理後文字，
CLI 路徑亦有 partial callback，具體頻率仍受執行 backend 影響，不能保證每個 token 都有獨立事件。[producer][oc-presentation]

本 repository 已在 `src/mattermost/monitor-turn.ts` 的 inbound plan 中註冊上述 callbacks，
並以 `createLivePreviewLifecycle` 管理最終持久化。因而新增 transport 可以留在 channel 邊界。
`src/mattermost/monitor-draft-delivery.ts` 目前 final edit 會讀回 post 並產生 receipt；
暫態 WebSocket 不能取代這份送達證據。

目前還有必要保留的公開可見行為：

- `reply_payload_sending` / `message_sending` hook 可改寫或取消時，關閉 provider preview；新 transport 不能繞過這道 gate。
- late plan 出現時，沿用既有 task-card/result 身分交接規則；串流不得繼續更新已轉為 task card 的舊 post。
- 多段 assistant、附件、長訊息、error、restart recovery 仍需原有 durable delivery 路徑。

## Mattermost 的真正邊界

Agents v2.10.0 `MMPostStreamService` 發送 `postupdate`，帶 `post_id` 與累積 `next`，
另有 `start`、`continue`、`cancel`、`end`。正文暫存在 client，結束、錯誤或取消時呼叫
`UpdatePost` 持久化。它並非「每個 token 直接改 post」。[官方 stream service][agents-stream]

關鍵限制不是 event 格式，而是誰能發送：

1. Mattermost server plugin 的 `PublishWebSocketEvent` 實作會強制組成
   `custom_<plugin-id>_<event>`。這是程式碼中的 namespace，不是可任意指定的參數。[實作][mm-publish]
2. 一般 bot WebSocket request 只能呼叫已註冊的 action；router 對未知 action 回錯。
   core 註冊的是 typing、status、ping 等，沒有任意廣播 Agents event 的入口。[router][mm-ws-router]、
   [初始化][mm-ws-init]、[user actions][mm-ws-user]、[system actions][mm-ws-system]、[status actions][mm-ws-status]
3. reviewed REST post routes 提供 create/update/patch，沒有一般 bot 可用的 stream lifecycle publish endpoint。[posts REST][mm-posts]

因此另一個 companion plugin 發送自己的 `postupdate`，
不會變成 `custom_mattermost-ai_postupdate`。把 event 名稱、post type 或 props 拼成 Agents 的樣子，
不足以建立可維護、可取消、可復原的互通能力。

Agents 的 `/bridge/v1/completion/agent/:agent` 與 `/service/:service`
是 **Mattermost plugin 間呼叫 Agents / provider 並讀回 completion** 的 API。
middleware 要求 server 注入的 `Mattermost-Plugin-ID`；
handler 向模型發出請求，並非接收 OpenClaw 已產生的片段來更新指定 post。
reviewed router 沒有一般 bot 的外部串流 ingestion API。[route/auth][agents-api]、[completion handler][agents-bridge]

## 原版 web/mobile 能否直接使用

Agents web 註冊的是 `custom_mattermost-ai_postupdate` 和 `custom_llmbot` renderer。
mobile 也將同名事件交給 Agents streaming store，並以特定 post type 選擇 Agents renderer。
這不是「任意 post 都自動接收所有自訂 WebSocket 事件」。[web registry][agents-web]、
[mobile event name][mobile-event]、[mobile routing][mobile-routing]、[post classification][mobile-utils]

另一方面，不能誤說 mobile 一定要求每個舊格式 post 都有 conversation：
官方仍保留沒有 `conversation_id` 的 legacy renderer，以持久化 `post.message` 收尾。
有 conversation 的新 renderer 則在結束時 refetch conversation。
Stop/Regenerate 都呼叫 Agents endpoint；一般外部 bot 的 post 即使進入 renderer，
也不代表 Agents 擁有其執行中的 OpenClaw run。[renderer 選擇][mobile-renderer]、
[stream settlement][mobile-settlement]、[generation controls][mobile-controls]

因此：

- 自有 server/web companion 可以使用獨立 namespace 和 renderer。
- 原版 mobile 不會因此自動得到同樣串流；保留定期 post edit 可延續既有文字預覽。
  若只做 WebSocket 而移除中途持久化，未支援的 client 只能看到已持久化內容，可能直到 final 才更新。
- 若要求原版 mobile 的完整 Agents UX，讓 Agents 本身管理輸出，或為 Agents 增加受支援的 external ingress，
  比假扮其 post/event 更合理。新增 ingress 屬另一個 repository 的實作。

## 另一條公開接法：Agents 把 OpenClaw 當 service

OpenClaw 10.7 有預設關閉的 `POST /v1/chat/completions`，
`stream:true` 回傳 OpenAI-compatible SSE，agent target 可用 `openclaw/default` 或 `openclaw/<agentId>`。
HTTP client 斷線會取消 agent run。[OpenClaw endpoint contract][oc-http-doc]、[handler][oc-http]

Agents 的 OpenAI-compatible service 支援自訂 API URL、model 與 key。
Bifrost chat 路徑把 `delta.content` 轉為 `llm.EventTypeText`，
再由既有 stream service 發送 WebSocket 與持久化。
因此基本文字的介面鏈條成立：

```text
Mattermost Agents
  → OpenAI-compatible HTTP request
  → OpenClaw agent
  → SSE delta.content
  → Agents llm.EventTypeText
  → Agents WebSocket / final UpdatePost
  → 現有 Agents web/mobile
```

[Agents service 設定][agents-service]、[chat conversion][agents-chat]、[provider network config][agents-account]。
這是介面比對得到的可行性推論，不是本輪已執行的整合結果。

接這條路之前仍需處理：

- **來源權限不同。** OpenClaw 文件明確將 shared bearer token 的此 endpoint 定義為 operator/owner surface；
  不能把 Mattermost 所有使用者默認升成 Gateway owner。若要多人使用，需獨立受限 agent/權限設計及身分映射，
  不能直接沿用一組 Gateway token 就宣稱有原 channel 的 sender 授權。
- **session 尚未映射。** OpenClaw 沒有 `user` 或 explicit session header 時，每個 HTTP request 使用新 session。
  reviewed Agents `convertToBifrostRequest` 沒有填入穩定 conversation 專屬的 OpenAI `user`；
  不應宣稱沿用現有 Mattermost thread session。Agents 自己提供 message history，
  但不等同 OpenClaw 的 durable thread session、任務續接及 callback 身分。
- **工具擁有者不同。** Agents 提供給 provider 的 function tools 與 OpenClaw 內部工具進度是不同契約；
  不能把內部 `onToolStart` 自動視為 Agents tool approval。
- **需要實測。** URL 正規化、chat/Responses 選擇、model routing、Stop 到實際 HTTP cancellation、
  授權拒絕、重試是否重複啟動 run、metadata 和錯誤 SSE 均未在此路線執行驗證。

## 保留目前 channel 的最小實作契約

下列是建議設計，尚未新增正式 runtime：

| 操作 | 契約 |
| --- | --- |
| capability handshake | 明確確認 server/web 支援的版本；未支援則維持現有 REST transport |
| open | 在合法的 result post 建立並取得 id 後，綁定 account、channel、thread、turn/run、generation；不能用 callback 開始順序推定 post 身分 |
| snapshot | 送出單調 seq 與完整文字；同 generation 舊 seq 不覆寫新狀態；限制大小、頻率、TTL 與每帳號並行數 |
| finish | 停止接受 producer tail，完成最後一次 durable edit 並讀回；成功後終結 stream。client 取得 authoritative final 前保留暫態文字 |
| cancel | 使用既有來源身分與 `/stop` admission 授權，精確對應當次 run；先 fence 晚到事件，再收尾持久化及 terminal card |
| identity handoff | 舊 result 轉 task card 時，先封閉舊 generation，把可見文字與結果所有權移到 successor，再開啟 successor 的 stream |
| recovery | 斷線可用完整 snapshot 續接；server/Gateway 重啟或租約過期不能永久顯示 generating；歷史內容以持久化 post 為準 |

bridge 必須核對 token 對應的 bot、post 所有權與 channel/thread 綁定，不能讓 caller 指定任意 broadcast audience。
若 finish/edit 結果未知，沿用現有 readback/reconciliation；
不得把「已送出 WS」當成「已接受 final」，也不得在 accepted-without-id 時重送製造重複 post。

建議第一版只做文字；推理可見性、工具、審批與計畫仍由目前的 channel 機制負責。
這樣可驗證 transport 是否有實際收益，避免同時搬動兩套工具與對話模型。

## 已執行的本機驗證

可重跑的 probe：[mattermost-streaming-probe.mjs](probes/mattermost-streaming-probe.mjs)。
它執行真實 published SDK `createLivePreviewLifecycle`、
官方 mobile `StreamingStore`（實際 React/RxJS），以及官方 web `PostEventListener`。
只 stub mobile logging；沒有改動 upstream state/store 程式。

**12 個案例通過：**

1. 暫態文字不會讓 SDK 誤認 final 已送達。
2. mobile 將完整 `next` 覆蓋，不會累加出重複文字。
3. replacement snapshot 能替換前一段文字。
4. SDK 以同一個 result id 完成 final，沒有第二次 create；成功的 persistence 先於 end。
5. 自有 adapter 的 seal fence 可擋住晚到 producer 文字。
6. web listener 可依同一 post id 收到 lifecycle 和內容。
7. authoritative persistence 接手後可清除 mobile 暫態 state。
8. mobile 的本地 Stop 會忽略晚到文字與推理。
9. **cancel 本身不是 producer fence**：cancel 後再收到 next，官方 store 會再次進入 generating；bridge 必須自己阻擋。
10. 漏接 start 時，完整 snapshot 可恢復文字；不同 server 的相同 post id 不混用。
11. **web listener 不是全文重播 cache**：事後訂閱者不會自動取得已過去的 next，重連需另有 readback/snapshot。
12. 持久化與 fallback 都失敗時，SDK final 仍為失敗，不能報成功。

驗證界線：callback 是合成呼叫；persistence 和事件 fanout 是記憶體替身。
未執行 live model/Gateway、Mattermost server plugin、HTTP/WS 認證、真實 UI、網路重連或手機 app。
第 5 項證明的是 probe adapter 的 fence 可運作，並非正式 bridge 已存在。

重跑方式（在 repo 根目錄）：

```bash
# SOURCE_ROOT 內需有已解壓的固定版本官方 sources：
# mattermost-plugin-agents-v2.10.0/ 與 mattermost-mobile-v2.45.0/
SOURCE_ROOT=/tmp/openclaw/mattermost-streaming-research-2026.10.7
mkdir -p "$SOURCE_ROOT/probe-runtime"
npm install --prefix "$SOURCE_ROOT/probe-runtime" \
  --ignore-scripts --no-audit --no-fund react@19.2.0 rxjs@7.8.2
node docs/probes/mattermost-streaming-probe.mjs "$SOURCE_ROOT"
```

probe 會輸出 `websocket-probe-receipt.json`，記錄 Node/SDK 版本、12 個 assertion、
實際執行的 upstream source SHA-256 與 persistence/event 順序。
本輪執行結果另保存為 [固定收據](probes/mattermost-streaming-probe-receipt.json)。
本輪來源 archives、原始 receipt 與產生的 bundle 保存在上述 `/tmp` research root；
它們不是 deployment artifact。

本輪只增加研究與可重跑 probe，沒有改動 production runtime、安裝 plugin、變更設定、
Gateway restart、對外訊息、commit 或 push。
下一階段若實作 companion，需另建其 owning repository；正式 rollout 還需新 inbound turn
證明 task card/result 順序、同一結果 id 的 final、取消、重連及 mobile fallback。

[oc-options]: https://github.com/openclaw/openclaw/blob/v2026.10.7/src/auto-reply/get-reply-options.types.ts
[oc-public-options]: https://github.com/openclaw/openclaw/blob/v2026.10.7/src/plugin-sdk/reply-options.ts
[oc-presentation]: https://github.com/openclaw/openclaw/blob/v2026.10.7/src/auto-reply/reply/agent-runner-presentation.ts
[oc-http-doc]: https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/gateway/openai-http-api.md
[oc-http]: https://github.com/openclaw/openclaw/blob/v2026.10.7/src/gateway/openai-http.ts
[agents-stream]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.10.0/streaming/streaming.go
[mm-publish]: https://github.com/mattermost/mattermost/blob/v12.0.1/server/channels/app/plugin_api.go
[mm-ws-router]: https://github.com/mattermost/mattermost/blob/v12.0.1/server/channels/app/platform/websocket_router.go
[mm-ws-init]: https://github.com/mattermost/mattermost/blob/v12.0.1/server/channels/wsapi/api.go
[mm-ws-user]: https://github.com/mattermost/mattermost/blob/v12.0.1/server/channels/wsapi/user.go
[mm-ws-system]: https://github.com/mattermost/mattermost/blob/v12.0.1/server/channels/wsapi/system.go
[mm-ws-status]: https://github.com/mattermost/mattermost/blob/v12.0.1/server/channels/wsapi/status.go
[mm-posts]: https://github.com/mattermost/mattermost/blob/v12.0.1/server/channels/api4/post.go
[agents-api]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.10.0/api/api.go
[agents-bridge]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.10.0/api/api_llm_bridge.go
[agents-web]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.10.0/webapp/src/index.tsx
[mobile-event]: https://github.com/mattermost/mattermost-mobile/blob/v2.45.0/app/constants/websocket.ts
[mobile-routing]: https://github.com/mattermost/mattermost-mobile/blob/v2.45.0/app/actions/websocket/event.ts
[mobile-utils]: https://github.com/mattermost/mattermost-mobile/blob/v2.45.0/app/products/agents/utils.ts
[mobile-renderer]: https://github.com/mattermost/mattermost-mobile/blob/v2.45.0/app/products/agents/components/agent_post/agent_post.tsx
[mobile-settlement]: https://github.com/mattermost/mattermost-mobile/blob/v2.45.0/app/products/agents/actions/websocket/index.ts
[mobile-controls]: https://github.com/mattermost/mattermost-mobile/blob/v2.45.0/app/products/agents/actions/remote/generation_controls.ts
[agents-service]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.10.0/bifrost/bifrost.go
[agents-chat]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.10.0/bifrost/chat.go
[agents-account]: https://github.com/mattermost/mattermost-plugin-agents/blob/v2.10.0/bifrost/account.go
