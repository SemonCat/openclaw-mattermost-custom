package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

const (
	protocolVersion = 1
	postType        = "custom_openclaw_stream"
	eventName       = "update"
	maxRequestBytes = 1 << 20
	maxTextUnits    = 262144
	maxStates       = 256
	snapshotTTL     = 15 * time.Second
	closedTTL       = 5 * time.Minute
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type Plugin struct {
	plugin.MattermostPlugin
	api       mattermostAPI
	allowedMu sync.RWMutex
	allowed   map[string]struct{}
	store     snapshotStore
}

type mattermostAPI interface {
	GetPost(postID string) (*model.Post, *model.AppError)
	GetUser(userID string) (*model.User, *model.AppError)
	GetSession(sessionID string) (*model.Session, *model.AppError)
	HasPermissionToChannel(userID, channelID string, permission *model.Permission) bool
	PublishWebSocketEvent(event string, payload map[string]any, broadcast *model.WebsocketBroadcast)
	LoadPluginConfiguration(dest any) error
}

type pluginConfig struct {
	AllowedBotIDs string `json:"AllowedBotIDs"`
}

type writeRequest struct {
	PostID     string `json:"post_id"`
	ChannelID  string `json:"channel_id"`
	RootID     string `json:"root_id"`
	Generation string `json:"generation"`
	Seq        uint64 `json:"seq"`
	Message    string `json:"message"`
}

type snapshot struct {
	PostID     string `json:"post_id"`
	ChannelID  string `json:"channel_id"`
	RootID     string `json:"root_id"`
	Generation string `json:"generation"`
	Seq        uint64 `json:"seq"`
	Message    string `json:"message"`
	Closed     bool   `json:"closed"`
	UpdatedAt  int64  `json:"updated_at"`
	ExpiresAt  int64  `json:"expires_at"`
	botID      string
	digest     [32]byte
}

type snapshotStore struct {
	mu     sync.Mutex
	states map[string]snapshot
	now    func() time.Time
}

func (s *snapshotStore) initialize() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.now == nil {
		s.now = time.Now
	}
	if s.states == nil {
		s.states = make(map[string]snapshot)
	}
}

func (s *snapshotStore) current(postID string) (snapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initializeLocked()
	state, ok := s.states[postID]
	if ok && s.now().UnixMilli() >= state.ExpiresAt {
		delete(s.states, postID)
		return snapshot{}, false
	}
	return state, ok
}

// publish applies either a full snapshot or a terminal close under one lock.
// A close advances exactly one sequence and identical retries are idempotent.
func (s *snapshotStore) publish(next snapshot, closeStream bool) (snapshot, bool, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initializeLocked()
	now := s.now()
	nowMillis := now.UnixMilli()
	for id, state := range s.states {
		if nowMillis >= state.ExpiresAt {
			delete(s.states, id)
		}
	}

	previous, exists := s.states[next.PostID]
	if exists {
		if !sameIdentity(previous, next) {
			return snapshot{}, false, http.StatusConflict
		}

		if closeStream {
			if previous.Closed {
				if next.Seq == previous.Seq && next.digest == previous.digest {
					return previous, true, http.StatusOK
				}
				return snapshot{}, false, http.StatusConflict
			}
			if previous.Seq == ^uint64(0) || next.Seq != previous.Seq+1 {
				return snapshot{}, false, http.StatusConflict
			}
			next.Message = previous.Message
		} else {
			if next.Seq == previous.Seq && next.digest == previous.digest {
				return previous, true, http.StatusOK
			}
			if previous.Closed || next.Seq <= previous.Seq {
				return snapshot{}, false, http.StatusConflict
			}
		}
	} else {
		if len(s.states) >= maxStates {
			return snapshot{}, false, http.StatusTooManyRequests
		}
	}

	next.UpdatedAt = nowMillis
	ttl := snapshotTTL
	if next.Closed {
		ttl = closedTTL
	}
	next.ExpiresAt = now.Add(ttl).UnixMilli()
	s.states[next.PostID] = next
	return next, false, http.StatusOK
}

func (s *snapshotStore) snapshotCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initializeLocked()
	return len(s.states)
}

func (s *snapshotStore) initializeLocked() {
	if s.now == nil {
		s.now = time.Now
	}
	if s.states == nil {
		s.states = make(map[string]snapshot)
	}
}

func sameIdentity(a, b snapshot) bool {
	return a.botID == b.botID &&
		a.Generation == b.Generation &&
		a.ChannelID == b.ChannelID &&
		a.RootID == b.RootID
}

func (p *Plugin) OnActivate() error {
	p.api = p.API
	p.store.initialize()
	return p.loadConfiguration()
}

func (p *Plugin) OnConfigurationChange() error {
	return p.loadConfiguration()
}

func (p *Plugin) loadConfiguration() error {
	var cfg pluginConfig
	if err := p.API.LoadPluginConfiguration(&cfg); err != nil {
		return err
	}
	allowed := make(map[string]struct{})
	for _, value := range strings.Split(cfg.AllowedBotIDs, ",") {
		if id := strings.TrimSpace(value); id != "" {
			allowed[id] = struct{}{}
		}
	}
	p.allowedMu.Lock()
	p.allowed = allowed
	p.allowedMu.Unlock()
	return nil
}

func (p *Plugin) ServeHTTP(c *plugin.Context, w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1/capabilities" && r.Method == http.MethodGet {
		p.handleCapabilities(w, r)
		return
	}
	if r.URL.Path == "/v1/snapshots" && r.Method == http.MethodPost {
		p.handleWrite(w, r, false)
		return
	}
	if r.URL.Path == "/v1/close" && r.Method == http.MethodPost {
		p.handleWrite(w, r, true)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/posts/") && r.Method == http.MethodGet {
		p.handleRead(c, w, r, strings.TrimPrefix(r.URL.Path, "/v1/posts/"))
		return
	}
	http.NotFound(w, r)
}

func (p *Plugin) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	if _, ok := p.authorizedBot(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"protocol": protocolVersion, "post_type": postType,
		"event": "custom_openclaw-stream_update", "lease_ms": snapshotTTL.Milliseconds(),
		"max_chars": maxTextUnits,
	})
}

func (p *Plugin) handleWrite(w http.ResponseWriter, r *http.Request, closeStream bool) {
	botID, ok := p.authorizedBot(w, r)
	if !ok {
		return
	}
	var input writeRequest
	if !decodeWriteJSON(w, r, &input, closeStream) || !validWrite(input, closeStream) {
		http.Error(w, "invalid stream request", http.StatusBadRequest)
		return
	}

	post, appErr := p.api.GetPost(input.PostID)
	if appErr != nil || post == nil || post.DeleteAt != 0 || !matchesPostIdentity(post, input, botID) {
		http.Error(w, "post is not an eligible OpenClaw result", http.StatusForbidden)
		return
	}
	if !p.api.HasPermissionToChannel(botID, input.ChannelID, model.PermissionCreatePost) {
		http.Error(w, "bot cannot post in channel", http.StatusForbidden)
		return
	}
	if closeStream {
		previous, exists := p.store.current(input.PostID)
		if exists {
			if previous.botID != botID || previous.Generation != input.Generation ||
				previous.ChannelID != input.ChannelID || previous.RootID != input.RootID {
				http.Error(w, "stream generation is not current", http.StatusConflict)
				return
			}
		} else if !matchesStreamGeneration(post, input) {
			http.Error(w, "post is not an eligible OpenClaw result", http.StatusForbidden)
			return
		}
	} else if !matchesPost(post, input, botID) {
		http.Error(w, "post is not an eligible OpenClaw result", http.StatusForbidden)
		return
	}

	event := snapshot{
		PostID: input.PostID, ChannelID: input.ChannelID, RootID: input.RootID,
		Generation: input.Generation, Seq: input.Seq, Message: input.Message,
		Closed: closeStream, botID: botID, digest: digest(input, closeStream),
	}
	published, replayed, status := p.store.publish(event, closeStream)
	if status != http.StatusOK {
		if status == http.StatusTooManyRequests {
			http.Error(w, "stream capacity reached", status)
		} else {
			http.Error(w, "stale or conflicting stream update", status)
		}
		return
	}
	if !replayed {
		p.api.PublishWebSocketEvent(eventName, published.payload(), &model.WebsocketBroadcast{
			ChannelId: published.ChannelID, ReliableClusterSend: true,
		})
	}
	writeJSON(w, http.StatusOK, map[string]bool{"accepted": true})
}

func (p *Plugin) authorizedBot(w http.ResponseWriter, r *http.Request) (string, bool) {
	userID := strings.TrimSpace(r.Header.Get("Mattermost-User-ID"))
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return "", false
	}
	if !p.isAllowedBot(userID) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return "", false
	}
	return userID, true
}

func (p *Plugin) isAllowedBot(userID string) bool {
	p.allowedMu.RLock()
	_, allowed := p.allowed[userID]
	p.allowedMu.RUnlock()
	if !allowed {
		return false
	}
	user, appErr := p.api.GetUser(userID)
	if appErr != nil || user == nil || !user.IsBot {
		return false
	}
	return true
}

func validWrite(input writeRequest, closeStream bool) bool {
	if input.PostID == "" || input.ChannelID == "" ||
		!uuidPattern.MatchString(input.Generation) ||
		input.Seq == 0 || input.Seq > 9007199254740991 {
		return false
	}
	if input.RootID == input.PostID || strings.ContainsAny(input.RootID, "/\\\r\n") {
		return false
	}
	if closeStream {
		return input.Message == ""
	}
	return len(input.Message) <= maxRequestBytes && len(utf16.Encode([]rune(input.Message))) <= maxTextUnits
}

func matchesPost(post *model.Post, input writeRequest, botID string) bool {
	if !matchesPostIdentity(post, input, botID) || !matchesStreamGeneration(post, input) {
		return false
	}
	identity, ok := propertyMap(post.Props["openclaw_mattermost"])
	return ok && identity["version"] == float64(1) &&
		identity["kind"] == "turn_result" && identity["channelId"] == input.ChannelID
}

func matchesPostIdentity(post *model.Post, input writeRequest, botID string) bool {
	return post.Id == input.PostID &&
		post.UserId == botID &&
		post.ChannelId == input.ChannelID &&
		post.RootId == input.RootID &&
		post.Type == postType
}

func matchesStreamGeneration(post *model.Post, input writeRequest) bool {
	stream, ok := propertyMap(post.Props["openclaw_stream"])
	return ok && stream["version"] == float64(protocolVersion) && stream["generation"] == input.Generation
}

func propertyMap(value any) (map[string]any, bool) {
	switch value := value.(type) {
	case map[string]any:
		return value, true
	case model.StringInterface:
		return map[string]any(value), true
	default:
		return nil, false
	}
}

func (s snapshot) payload() map[string]any {
	return map[string]any{
		"post_id": s.PostID, "channel_id": s.ChannelID, "root_id": s.RootID,
		"generation": s.Generation, "seq": s.Seq, "message": s.Message,
		"closed": s.Closed, "updated_at": s.UpdatedAt, "expires_at": s.ExpiresAt,
	}
}

func digest(input writeRequest, closeStream bool) [32]byte {
	copy := input
	if closeStream {
		copy.Message = "<close>"
	}
	value, _ := json.Marshal(copy)
	return sha256.Sum256(value)
}

func (p *Plugin) handleRead(c *plugin.Context, w http.ResponseWriter, r *http.Request, postID string) {
	if postID == "" || strings.ContainsAny(postID, "/\\\r\n") {
		http.Error(w, "invalid post ID", http.StatusBadRequest)
		return
	}
	if c == nil || strings.TrimSpace(c.SessionId) == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	session, appErr := p.api.GetSession(c.SessionId)
	if appErr != nil || session == nil || session.UserId == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	state, ok := p.store.current(postID)
	if !ok {
		http.NotFound(w, r)
		return
	}
	if !p.api.HasPermissionToChannel(session.UserId, state.ChannelID, model.PermissionReadChannel) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if !p.isAllowedBot(state.botID) {
		http.NotFound(w, r)
		return
	}
	post, appErr := p.api.GetPost(postID)
	if appErr != nil || post == nil ||
		post.DeleteAt != 0 ||
		!matchesPost(post, writeRequest{
			PostID: state.PostID, ChannelID: state.ChannelID, RootID: state.RootID,
			Generation: state.Generation,
		}, state.botID) {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func decodeWriteJSON(w http.ResponseWriter, r *http.Request, dst *writeRequest, closeStream bool) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return false
	}
	required := []string{"post_id", "channel_id", "root_id", "generation", "seq"}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			return false
		}
	}
	if closeStream {
		if _, ok := fields["message"]; ok {
			return false
		}
	} else if _, ok := fields["message"]; !ok {
		return false
	}
	var extra any
	if !errors.Is(decoder.Decode(&extra), io.EOF) {
		return false
	}
	for key := range fields {
		switch key {
		case "post_id", "channel_id", "root_id", "generation", "seq", "message":
		default:
			return false
		}
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return false
	}
	return json.Unmarshal(encoded, dst) == nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
