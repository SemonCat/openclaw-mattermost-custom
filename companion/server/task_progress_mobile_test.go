package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
)

func mobilePost() *model.Post {
	post := taskPost()
	post.Message = "#### Task progress · In progress\nReview PR\n\n- [x] Read diff\n- [ ] Run tests"
	post.Props["openclaw_task_progress"] = map[string]any{
		"version": float64(1), "source_message": post.Message, "title": "Review PR", "status": "in_progress",
		"steps":                []any{map[string]any{"step": "Read diff", "status": "completed"}, map[string]any{"step": "Run tests", "status": "in_progress"}},
		"work_sessions":        []any{map[string]any{"label": "Child", "status": "running", "url": "https://example.test/a(b)"}},
		"hidden_work_sessions": float64(0),
	}
	return post
}

// Match the server's JSON/GOB plugin boundary, including maps and nil arrays.
func wirePost(post *model.Post) *model.Post {
	raw, _ := json.Marshal(post)
	var copy model.Post
	_ = json.Unmarshal(raw, &copy)
	return &copy
}

func TestNativeTaskProjectionAndWriteback(t *testing.T) {
	p, _ := newTestPlugin()
	input := mobilePost()
	stored, reason := p.MessageWillBePosted(nil, input)
	if reason != "" || stored.Message != input.Message || stored.Type != taskProgressPostType ||
		!emptyTaskAttachments(stored.Props["attachments"]) {
		t.Fatal("must persist canonical text and an empty native embed slot")
	}
	projected := wirePost(p.MessagesWillBeConsumed([]*model.Post{stored})[0])
	if projected.Message != "#### Task progress · In progress" || stored.Message != input.Message {
		t.Fatal("consumption must project only the visible body, without mutating storage")
	}
	attachment := projected.Props["attachments"].([]any)[0].(map[string]any)
	block := projected.Props["mm_blocks"].([]any)[0].(map[string]any)
	if block["type"] != "collapsible" || block["collapsed"] != true ||
		block["content"].([]any)[0].(map[string]any)["text"] != strings.TrimPrefix(input.Message, "#### Task progress · In progress\n") {
		t.Fatal("native task details must start closed and contain the canonical checklist once")
	}
	raw, _ := json.Marshal(attachment)
	if !strings.Contains(string(raw), "✓ Read diff") || !strings.Contains(string(raw), "▶ Run tests") ||
		!strings.Contains(string(raw), "https://example.test/a%28b%29") {
		t.Fatalf("missing native content: %s", raw)
	}
	for _, status := range []string{"In progress", "Completed", "Incomplete", "Failed", "Cancelled"} {
		incoming := projected.Clone()
		incoming.Message = "#### Task progress · " + status
		updated, reason := p.MessageWillBeUpdated(nil, incoming, stored)
		if reason != "" || updated.Message != strings.Replace(input.Message, "In progress", status, 1) ||
			!emptyTaskAttachments(updated.Props["attachments"]) || updated.Props[taskMobileProp] != nil ||
			updated.Props["mm_blocks"] != nil {
			t.Fatalf("projection roundtrip %s lost canonical content: %s", status, reason)
		}
		visible := p.MessagesWillBeConsumed([]*model.Post{updated})[0]
		raw, _ := json.Marshal(visible.Props["attachments"])
		if status != "In progress" && strings.Contains(string(raw), "▶") {
			t.Fatalf("terminal %s retained running state: %s", status, raw)
		}
	}
}

func TestChildOnlyNativeProjectionUpgradeAndFallback(t *testing.T) {
	p, _ := newTestPlugin()
	post := mobilePost()
	identity := post.Props["openclaw_mattermost"].(map[string]any)
	identity["kind"] = "subagent_progress"
	card := post.Props["openclaw_task_progress"].(map[string]any)
	post.Message = "#### Task progress · In progress\n\n##### Subagents\n- [ ] Child · Running"
	card["source_message"], card["steps"] = post.Message, []any{}
	delete(card, "title")
	card["work_session_counts"] = map[string]any{
		"queued": float64(0), "running": float64(2), "completed": float64(3),
		"failed": float64(1), "cancelled": float64(0),
	}
	stored, reason := p.MessageWillBePosted(nil, post)
	if reason != "" || stored.Type != taskProgressPostType || stored.Message != post.Message {
		t.Fatal("child-only admission must retain the same canonical storage and renderer")
	}
	projected := wirePost(p.MessagesWillBeConsumed([]*model.Post{stored})[0])
	block := projected.Props["mm_blocks"].([]any)[0].(map[string]any)
	header := block["header"].([]any)
	if header[0].(map[string]any)["text"] != "Agent details" ||
		!strings.Contains(header[1].(map[string]any)["text"].(string), "2 running · 3 completed · 1 failed") {
		t.Fatal("collapsed child-only header must show real aggregate counts without a fake plan")
	}
	if !strings.Contains(projected.Props["attachments"].([]any)[0].(map[string]any)["footer"].(string), "2 running") {
		t.Fatal("Blocks-disabled native attachment must retain truthful aggregate summary")
	}
	restored, reason := p.MessageWillBeUpdated(nil, projected, stored)
	if reason != "" || restored.Message != post.Message {
		t.Fatal("child-only projected writes must restore complete canonical Markdown")
	}
	newer := stored.Clone()
	newer.Message += "\nNew child"
	if _, reason := p.MessageWillBeUpdated(nil, projected, newer); reason == "" {
		t.Fatal("stale child-only projection must not overwrite newer progress")
	}
	upgrade := wirePost(stored)
	upgrade.Props["openclaw_mattermost"].(map[string]any)["kind"] = "task_progress"
	upgraded, reason := p.MessageWillBeUpdated(nil, upgrade, stored)
	if reason != "" || upgraded.Id != stored.Id || p.nativeTask(upgraded) == nil {
		t.Fatal("late real plan must keep the original physical child-card identity")
	}
	for _, kind := range []string{"turn_result", "forged"} {
		foreign := wirePost(stored)
		foreign.Props["openclaw_mattermost"].(map[string]any)["kind"] = kind
		if p.nativeTask(foreign) != nil {
			t.Fatal("new kind admission must remain an exact allowlist")
		}
	}
}

func TestFailedParentPreservesActualNativeChildStates(t *testing.T) {
	p, _ := newTestPlugin()
	post := mobilePost()
	post.Message = strings.Replace(post.Message, "In progress", "Failed", 1)
	card := post.Props["openclaw_task_progress"].(map[string]any)
	card["status"], card["source_message"] = "failed", post.Message
	card["work_sessions"] = []any{
		map[string]any{"label": "Reviewer", "status": "running"},
		map[string]any{"label": "Verifier", "status": "queued"},
	}
	card["work_session_counts"] = map[string]any{
		"queued": float64(1), "running": float64(1), "completed": float64(0),
		"failed": float64(0), "cancelled": float64(0),
	}
	projected := p.MessagesWillBeConsumed([]*model.Post{p.prepareNativeTask(post)})[0]
	raw, _ := json.Marshal(projected.Props["attachments"])
	if !strings.Contains(string(raw), "Reviewer · Running") ||
		!strings.Contains(string(raw), "Verifier · Queued") || strings.Contains(string(raw), "▶") {
		t.Fatalf("terminal parent must stop animation without falsifying child state: %s", raw)
	}
	header := projected.Props["mm_blocks"].([]any)[0].(map[string]any)["header"].([]any)
	if !strings.Contains(header[1].(map[string]any)["text"].(string), "1 running · 1 queued") {
		t.Fatal("collapsed native summary must agree with actual child rows")
	}
	if !strings.Contains(string(raw), "Failed · 1 of 2 steps completed · 1 running · 1 queued") {
		t.Fatal("Blocks-disabled attachment must keep terminal status and actual child counts")
	}
}

func TestNativeTaskAdmissionAndForeignAttachments(t *testing.T) {
	for name, change := range map[string]func(*model.Post){
		"human":         func(post *model.Post) { post.UserId = "human" },
		"foreign bot":   func(post *model.Post) { post.UserId = "stranger" },
		"foreign route": func(post *model.Post) { post.RootId = "other" },
		"stale":         func(post *model.Post) { post.Message += "\nEdited" },
		"bad step": func(post *model.Post) {
			post.Props["openclaw_task_progress"].(map[string]any)["steps"] = []any{map[string]any{"step": "x", "status": "invented"}}
		},
		"too many": func(post *model.Post) {
			post.Props["openclaw_task_progress"].(map[string]any)["steps"] = make([]any, 51)
		},
		"bad field":      func(post *model.Post) { post.Props["openclaw_task_progress"].(map[string]any)["title"] = nil },
		"missing arrays": func(post *model.Post) { delete(post.Props["openclaw_task_progress"].(map[string]any), "steps") },
		"nil hidden": func(post *model.Post) {
			post.Props["openclaw_task_progress"].(map[string]any)["hidden_work_sessions"] = nil
		},
		"missing step": func(post *model.Post) {
			post.Props["openclaw_task_progress"].(map[string]any)["steps"] = []any{map[string]any{"status": "completed"}}
		},
		"nil step": func(post *model.Post) {
			post.Props["openclaw_task_progress"].(map[string]any)["steps"] = []any{map[string]any{"step": nil, "status": "completed"}}
		},
		"missing label": func(post *model.Post) {
			post.Props["openclaw_task_progress"].(map[string]any)["work_sessions"] = []any{map[string]any{"status": "running"}}
		},
		"nil label": func(post *model.Post) {
			post.Props["openclaw_task_progress"].(map[string]any)["work_sessions"] = []any{map[string]any{"label": nil, "status": "running"}}
		},
		"nil progress": func(post *model.Post) {
			post.Props["openclaw_task_progress"].(map[string]any)["work_sessions"] = []any{map[string]any{"label": "Child", "status": "running", "progress": nil}}
		},
		"foreign attachments": func(post *model.Post) { post.AddProp("attachments", []any{map[string]any{"text": "foreign"}}) },
	} {
		t.Run(name, func(t *testing.T) {
			p, _ := newTestPlugin()
			post := mobilePost()
			change(post)
			before, _ := json.Marshal(post)
			prepared := p.prepareNativeTask(post)
			projected := p.MessagesWillBeConsumed([]*model.Post{prepared})[0]
			after, _ := json.Marshal(projected)
			if string(before) != string(after) {
				t.Fatal("invalid or foreign payload must remain untouched")
			}
		})
	}
}

func TestNativeTaskNilArraysAndUnsafeLabels(t *testing.T) {
	p, _ := newTestPlugin()
	post := mobilePost()
	card := post.Props["openclaw_task_progress"].(map[string]any)
	card["steps"], card["work_sessions"] = nil, nil
	if p.nativeTask(post) == nil {
		t.Fatal("RPC nil arrays must be accepted")
	}
	card["work_sessions"] = []any{map[string]any{
		"label": "![image](https://evil.test)", "status": "running", "url": "javascript:alert(1)",
	}}
	prepared := p.prepareNativeTask(post)
	projected := p.MessagesWillBeConsumed([]*model.Post{prepared})[0]
	raw, _ := json.Marshal(projected.Props["attachments"])
	if strings.Contains(string(raw), "javascript:") || strings.Contains(string(raw), `"value":"▶ ![image]`) {
		t.Fatal("unsafe URLs and Markdown labels must not become executable attachment content")
	}
}

func TestNativeTaskStaleProjectionAndExplicitEdits(t *testing.T) {
	p, _ := newTestPlugin()
	stored := p.prepareNativeTask(mobilePost())
	projected := wirePost(p.MessagesWillBeConsumed([]*model.Post{stored})[0])
	newer := stored.Clone()
	newer.Message += "\nNew visible content"
	if _, reason := p.MessageWillBeUpdated(nil, projected, newer); reason == "" {
		t.Fatal("stale projection must not overwrite newer storage")
	}
	edited := projected.Clone()
	edited.Message += "\nHuman edit"
	got, reason := p.MessageWillBeUpdated(nil, edited, stored)
	if reason != "" || got.Message != edited.Message || got.Props[taskMobileProp] != nil {
		t.Fatal("explicit user text edits must survive without a stale projection marker")
	}
	before := wirePost(stored)
	p.MessagesWillBeConsumed([]*model.Post{stored})
	if !reflect.DeepEqual(before, wirePost(stored)) {
		t.Fatal("projection mutated persisted props")
	}
}
