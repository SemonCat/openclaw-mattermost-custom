package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

const (
	testBotID      = "bot-user"
	testChannelID  = "channel-id"
	testPostID     = "post-id"
	testGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
)

type fakeAPI struct {
	post     *model.Post
	users    map[string]*model.User
	sessions map[string]*model.Session
	readable map[string]bool
	postable map[string]bool
	events   []fakeEvent
}

type fakeEvent struct {
	name      string
	payload   map[string]any
	broadcast *model.WebsocketBroadcast
}

func (f *fakeAPI) GetPost(postID string) (*model.Post, *model.AppError) {
	if f.post == nil || f.post.Id != postID {
		return nil, nil
	}
	return f.post, nil
}

func (f *fakeAPI) GetUser(userID string) (*model.User, *model.AppError) {
	return f.users[userID], nil
}

func (f *fakeAPI) GetSession(sessionID string) (*model.Session, *model.AppError) {
	return f.sessions[sessionID], nil
}

func (f *fakeAPI) HasPermissionToChannel(userID, channelID string, permission *model.Permission) bool {
	if channelID != testChannelID {
		return false
	}
	if permission == model.PermissionCreatePost {
		return f.postable[userID]
	}
	return f.readable[userID]
}

func (f *fakeAPI) PublishWebSocketEvent(name string, payload map[string]any, broadcast *model.WebsocketBroadcast) {
	f.events = append(f.events, fakeEvent{name: name, payload: payload, broadcast: broadcast})
}

func (f *fakeAPI) LoadPluginConfiguration(dest any) error {
	cfg := dest.(*pluginConfig)
	cfg.AllowedBotIDs = " " + testBotID + ", other-bot "
	return nil
}

func newTestPlugin() (*Plugin, *fakeAPI) {
	api := &fakeAPI{
		post: &model.Post{
			Id:        testPostID,
			UserId:    testBotID,
			ChannelId: testChannelID,
			Type:      postType,
			Props: model.StringInterface{
				"openclaw_mattermost": map[string]any{
					"version": float64(1), "kind": "turn_result", "channelId": testChannelID,
				},
				"openclaw_stream": map[string]any{
					"version": float64(1), "generation": testGeneration,
				},
			},
		},
		users: map[string]*model.User{
			testBotID:   {Id: testBotID, IsBot: true},
			"other-bot": {Id: "other-bot", IsBot: true},
			"human":     {Id: "human", IsBot: false},
			"stranger":  {Id: "stranger", IsBot: true},
		},
		sessions: map[string]*model.Session{
			"reader-session":   {UserId: "reader"},
			"outsider-session": {UserId: "outsider"},
		},
		readable: map[string]bool{"reader": true},
		postable: map[string]bool{testBotID: true, "other-bot": true},
	}
	p := &Plugin{
		api:     api,
		allowed: map[string]struct{}{testBotID: {}, "other-bot": {}},
		store: snapshotStore{
			states: make(map[string]snapshot),
			now:    time.Now,
		},
	}
	return p, api
}

func requestJSON(t *testing.T, p *Plugin, method, path string, body any, botID, sessionID string) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	return requestBytes(p, method, path, data, botID, sessionID)
}

func requestBytes(p *Plugin, method, path string, body []byte, botID, sessionID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if botID != "" {
		req.Header.Set("Mattermost-User-ID", botID)
	}
	recorder := httptest.NewRecorder()
	var ctx *plugin.Context
	if sessionID != "" {
		ctx = &plugin.Context{SessionId: sessionID}
	}
	p.ServeHTTP(ctx, recorder, req)
	return recorder
}

func snapshotBody(postID string, seq uint64, message string) writeRequest {
	return writeRequest{
		PostID: postID, ChannelID: testChannelID, RootID: "",
		Generation: testGeneration, Seq: seq, Message: message,
	}
}

func closeBody(postID string, seq uint64) map[string]any {
	return map[string]any{
		"post_id": postID, "channel_id": testChannelID, "root_id": "",
		"generation": testGeneration, "seq": seq,
	}
}

func TestServeHTTPSnapshotAndAuthorizedRead(t *testing.T) {
	p, api := newTestPlugin()
	body := snapshotBody(testPostID, 1, "live response")
	recorder := requestJSON(t, p, http.MethodPost, "/v1/snapshots", body, testBotID, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body)
	}
	replay := requestJSON(t, p, http.MethodPost, "/v1/snapshots", body, testBotID, "")
	if replay.Code != http.StatusOK {
		t.Fatalf("identical snapshot replay status = %d, want %d: %s", replay.Code, http.StatusOK, replay.Body)
	}
	if len(api.events) != 1 {
		t.Fatalf("published events after exact replay = %d, want 1", len(api.events))
	}
	event := api.events[0]
	if event.name != eventName || event.payload["message"] != "live response" {
		t.Fatalf("unexpected event: %#v", event)
	}
	if event.broadcast.ChannelId != testChannelID || !event.broadcast.ReliableClusterSend {
		t.Fatalf("unexpected broadcast scope: %#v", event.broadcast)
	}
	if _, ok := event.payload["updated_at"]; !ok {
		t.Fatalf("event has no server updated_at: %#v", event.payload)
	}

	read := requestJSON(t, p, http.MethodGet, "/v1/posts/"+testPostID, nil, "outsider", "reader-session")
	if read.Code != http.StatusOK {
		t.Fatalf("authorized read status = %d, want %d: %s", read.Code, http.StatusOK, read.Body)
	}
	var got snapshot
	if err := json.Unmarshal(read.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Message != "live response" || got.Generation != testGeneration || got.Seq != 1 {
		t.Fatalf("unexpected read snapshot: %#v", got)
	}
}

func TestServeHTTPCloseCanCreateTerminalTombstone(t *testing.T) {
	p, api := newTestPlugin()
	closeRequest := closeBody(testPostID, 1)
	closed := requestJSON(t, p, http.MethodPost, "/v1/close", closeRequest, testBotID, "")
	if closed.Code != http.StatusOK {
		t.Fatalf("first close status = %d, want %d: %s", closed.Code, http.StatusOK, closed.Body)
	}
	replay := requestJSON(t, p, http.MethodPost, "/v1/close", closeRequest, testBotID, "")
	if replay.Code != http.StatusOK {
		t.Fatalf("first close replay status = %d, want %d: %s", replay.Code, http.StatusOK, replay.Body)
	}
	if len(api.events) != 1 || api.events[0].payload["closed"] != true {
		t.Fatalf("first close should publish exactly one terminal event: %#v", api.events)
	}
	late := requestJSON(t, p, http.MethodPost, "/v1/snapshots", snapshotBody(testPostID, 2, "late"), testBotID, "")
	if late.Code != http.StatusConflict {
		t.Fatalf("snapshot after tombstone status = %d, want %d", late.Code, http.StatusConflict)
	}
}

func TestServeHTTPRequiresBotPostPermissionAndRejectsDeletedPost(t *testing.T) {
	p, api := newTestPlugin()
	api.postable[testBotID] = false
	denied := requestJSON(t, p, http.MethodPost, "/v1/snapshots", snapshotBody(testPostID, 1, "text"), testBotID, "")
	if denied.Code != http.StatusForbidden {
		t.Fatalf("bot without post permission status = %d, want %d", denied.Code, http.StatusForbidden)
	}

	api.postable[testBotID] = true
	api.post.DeleteAt = time.Now().UnixMilli()
	deleted := requestJSON(t, p, http.MethodPost, "/v1/snapshots", snapshotBody(testPostID, 1, "text"), testBotID, "")
	if deleted.Code != http.StatusForbidden {
		t.Fatalf("deleted post write status = %d, want %d", deleted.Code, http.StatusForbidden)
	}
}

func TestServeHTTPReadHidesStaleTaskCardsAndDeletedPosts(t *testing.T) {
	p, api := newTestPlugin()
	write := requestJSON(t, p, http.MethodPost, "/v1/snapshots", snapshotBody(testPostID, 1, "text"), testBotID, "")
	if write.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d", write.Code)
	}

	api.post.Props["openclaw_mattermost"] = map[string]any{
		"version": float64(1), "kind": "task_card", "channelId": testChannelID,
	}
	handoff := requestJSON(t, p, http.MethodGet, "/v1/posts/"+testPostID, nil, "reader", "reader-session")
	if handoff.Code != http.StatusNotFound {
		t.Fatalf("task card snapshot status = %d, want %d", handoff.Code, http.StatusNotFound)
	}

	api.post.Props["openclaw_mattermost"] = map[string]any{
		"version": float64(1), "kind": "turn_result", "channelId": testChannelID,
	}
	api.post.DeleteAt = time.Now().UnixMilli()
	deleted := requestJSON(t, p, http.MethodGet, "/v1/posts/"+testPostID, nil, "reader", "reader-session")
	if deleted.Code != http.StatusNotFound {
		t.Fatalf("deleted post snapshot status = %d, want %d", deleted.Code, http.StatusNotFound)
	}
}

func TestServeHTTPRejectsPublisherAdmissionFailures(t *testing.T) {
	tests := []struct {
		name            string
		userID          string
		allowNonBotUser bool
		status          int
	}{
		{name: "missing identity", status: http.StatusUnauthorized},
		{name: "nonallowlisted bot", userID: "stranger", status: http.StatusForbidden},
		{name: "allowlisted nonbot", userID: "human", allowNonBotUser: true, status: http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			p, _ := newTestPlugin()
			if test.allowNonBotUser {
				p.allowedMu.Lock()
				p.allowed[test.userID] = struct{}{}
				p.allowedMu.Unlock()
			}
			recorder := requestJSON(t, p, http.MethodPost, "/v1/snapshots", snapshotBody(testPostID, 1, "text"), test.userID, "")
			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d", recorder.Code, test.status)
			}
		})
	}

	p, _ := newTestPlugin()
	recorder := requestJSON(t, p, http.MethodGet, "/v1/capabilities", nil, "human", "")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("capabilities status = %d, want %d", recorder.Code, http.StatusForbidden)
	}
}

func TestServeHTTPRejectsForeignAndMalformedPosts(t *testing.T) {
	tests := []struct {
		name   string
		change func(*model.Post)
	}{
		{name: "wrong author", change: func(post *model.Post) { post.UserId = "other-bot" }},
		{name: "wrong channel", change: func(post *model.Post) { post.ChannelId = "other-channel" }},
		{name: "wrong thread", change: func(post *model.Post) { post.RootId = "other-root" }},
		{name: "wrong type", change: func(post *model.Post) { post.Type = "custom_other" }},
		{name: "wrong generation", change: func(post *model.Post) {
			post.Props["openclaw_stream"] = map[string]any{"version": float64(1), "generation": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}
		}},
		{name: "not a turn result", change: func(post *model.Post) {
			post.Props["openclaw_mattermost"] = map[string]any{"version": float64(1), "kind": "task_card", "channelId": testChannelID}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			p, api := newTestPlugin()
			test.change(api.post)
			recorder := requestJSON(t, p, http.MethodPost, "/v1/snapshots", snapshotBody(testPostID, 1, "text"), testBotID, "")
			if recorder.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
			}
			if len(api.events) != 0 {
				t.Fatalf("foreign post published %d events", len(api.events))
			}
		})
	}
}

func TestServeHTTPCloseIsFencedAndReplaySafeAfterHandoff(t *testing.T) {
	p, api := newTestPlugin()
	first := requestJSON(t, p, http.MethodPost, "/v1/snapshots", snapshotBody(testPostID, 1, "latest text"), testBotID, "")
	if first.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d, want %d: %s", first.Code, http.StatusOK, first.Body)
	}

	// The result post may have been handed off to the task card before close.
	api.post.Props["openclaw_mattermost"] = map[string]any{"version": float64(1), "kind": "task_card", "channelId": testChannelID}
	delete(api.post.Props, "openclaw_stream")

	closeRequest := closeBody(testPostID, 2)
	closed := requestJSON(t, p, http.MethodPost, "/v1/close", closeRequest, testBotID, "")
	if closed.Code != http.StatusOK {
		t.Fatalf("close status = %d, want %d: %s", closed.Code, http.StatusOK, closed.Body)
	}
	replay := requestJSON(t, p, http.MethodPost, "/v1/close", closeRequest, testBotID, "")
	if replay.Code != http.StatusOK {
		t.Fatalf("close replay status = %d, want %d: %s", replay.Code, http.StatusOK, replay.Body)
	}
	if len(api.events) != 2 {
		t.Fatalf("published events = %d, want snapshot and one close", len(api.events))
	}
	closedEvent := api.events[1]
	if closedEvent.payload["closed"] != true || closedEvent.payload["message"] != "latest text" {
		t.Fatalf("close did not preserve the latest text: %#v", closedEvent.payload)
	}

	api.post.Props["openclaw_mattermost"] = map[string]any{
		"version": float64(1), "kind": "turn_result", "channelId": testChannelID,
	}
	api.post.Props["openclaw_stream"] = map[string]any{
		"version": float64(1), "generation": testGeneration,
	}
	late := requestJSON(t, p, http.MethodPost, "/v1/snapshots", snapshotBody(testPostID, 3, "late text"), testBotID, "")
	if late.Code != http.StatusConflict {
		t.Fatalf("snapshot after close status = %d, want %d", late.Code, http.StatusConflict)
	}
}

func TestServeHTTPRejectsStaleAndConflictingRequests(t *testing.T) {
	for _, test := range []struct {
		name string
		seq  uint64
		text string
	}{
		{name: "same sequence different body", seq: 2, text: "different"},
		{name: "stale sequence", seq: 1, text: "stale"},
		{name: "skipped close sequence", seq: 4, text: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			p, _ := newTestPlugin()
			first := requestJSON(t, p, http.MethodPost, "/v1/snapshots", snapshotBody(testPostID, 2, "first"), testBotID, "")
			if first.Code != http.StatusOK {
				t.Fatalf("initial snapshot status = %d", first.Code)
			}
			if test.name == "skipped close sequence" {
				body := closeBody(testPostID, test.seq)
				recorder := requestJSON(t, p, http.MethodPost, "/v1/close", body, testBotID, "")
				if recorder.Code != http.StatusConflict {
					t.Fatalf("close status = %d, want %d", recorder.Code, http.StatusConflict)
				}
				return
			}
			recorder := requestJSON(t, p, http.MethodPost, "/v1/snapshots", snapshotBody(testPostID, test.seq, test.text), testBotID, "")
			if recorder.Code != http.StatusConflict {
				t.Fatalf("snapshot status = %d, want %d", recorder.Code, http.StatusConflict)
			}
		})
	}
}

func TestServeHTTPReadUsesPluginSessionNotUserHeader(t *testing.T) {
	p, _ := newTestPlugin()
	write := requestJSON(t, p, http.MethodPost, "/v1/snapshots", snapshotBody(testPostID, 1, "text"), testBotID, "")
	if write.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d", write.Code)
	}
	forged := httptest.NewRequest(http.MethodGet, "/v1/posts/"+testPostID, nil)
	forged.Header.Set("Mattermost-User-ID", "outsider")
	recorder := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{SessionId: "reader-session"}, recorder, forged)
	if recorder.Code != http.StatusOK {
		t.Fatalf("session-authorized read status = %d, want %d", recorder.Code, http.StatusOK)
	}

	denied := requestJSON(t, p, http.MethodGet, "/v1/posts/"+testPostID, nil, "reader", "outsider-session")
	if denied.Code != http.StatusForbidden {
		t.Fatalf("unauthorized channel read status = %d, want %d", denied.Code, http.StatusForbidden)
	}
	missing := requestJSON(t, p, http.MethodGet, "/v1/posts/"+testPostID, nil, "reader", "")
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("missing session status = %d, want %d", missing.Code, http.StatusUnauthorized)
	}
}

func TestServeHTTPRejectsMissingOrUnknownFields(t *testing.T) {
	p, _ := newTestPlugin()
	missing := []byte(`{"post_id":"post-id","channel_id":"channel-id","generation":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","seq":1,"message":"text"}`)
	recorder := requestBytes(p, http.MethodPost, "/v1/snapshots", missing, testBotID, "")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("missing root_id status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	unknown, err := json.Marshal(map[string]any{
		"post_id": testPostID, "channel_id": testChannelID, "root_id": "",
		"generation": testGeneration, "seq": 1, "message": "text", "unexpected": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder = requestBytes(p, http.MethodPost, "/v1/snapshots", unknown, testBotID, "")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestServeHTTPRejectsOversizedTextAndBody(t *testing.T) {
	p, _ := newTestPlugin()
	body := snapshotBody(testPostID, 1, strings.Repeat("x", maxTextUnits+1))
	recorder := requestJSON(t, p, http.MethodPost, "/v1/snapshots", body, testBotID, "")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("oversized text status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}

	large := []byte(`{"payload":"` + strings.Repeat("x", maxRequestBytes+1) + `"}`)
	recorder = requestBytes(p, http.MethodPost, "/v1/snapshots", large, testBotID, "")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("oversized body status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestSnapshotStoreExpiresAndBoundsState(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	store := snapshotStore{now: func() time.Time { return now }}
	for i := 0; i < maxStates; i++ {
		postID := "post-" + strconv.Itoa(i)
		event := snapshot{
			PostID: postID, ChannelID: testChannelID, Generation: testGeneration,
			Seq: 1, Message: "text", botID: testBotID,
			digest: digest(writeRequest{PostID: postID, ChannelID: testChannelID, Generation: testGeneration, Seq: 1, Message: "text"}, false),
		}
		if _, _, status := store.publish(event, false); status != http.StatusOK {
			t.Fatalf("publish %d status = %d, want %d", i, status, http.StatusOK)
		}
	}
	if store.snapshotCount() != maxStates {
		t.Fatalf("state count = %d, want %d", store.snapshotCount(), maxStates)
	}
	extra := snapshot{PostID: "overflow", ChannelID: testChannelID, Generation: testGeneration, Seq: 1, botID: testBotID}
	if _, _, status := store.publish(extra, false); status != http.StatusTooManyRequests {
		t.Fatalf("overflow status = %d, want %d", status, http.StatusTooManyRequests)
	}

	now = now.Add(snapshotTTL + time.Millisecond)
	if _, ok := store.current("post-0"); ok {
		t.Fatal("expired state is still readable")
	}
	if _, _, status := store.publish(extra, false); status != http.StatusOK {
		t.Fatalf("publish after expiry status = %d, want %d", status, http.StatusOK)
	}
}
