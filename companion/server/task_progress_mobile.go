package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"regexp"
	"strings"

	"github.com/mattermost/mattermost/server/public/model"
)

const taskMobileProp = "openclaw_task_mobile"

var taskHeading = regexp.MustCompile(`^#### Task progress · (In progress|Completed|Incomplete|Failed|Cancelled)(\n|$)`)
var taskMarkdown = regexp.MustCompile("([\\\\`*_{}\\[\\]()<>!|#~])")

type mobileTask struct {
	Version     int    `json:"version"`
	Source      string `json:"source_message"`
	Title       string `json:"title"`
	Explanation string `json:"explanation"`
	Status      string `json:"status"`
	Hidden      int    `json:"hidden_work_sessions"`
	Steps       []struct {
		Step   string `json:"step"`
		Status string `json:"status"`
	} `json:"steps"`
	Work []struct {
		Label    string `json:"label"`
		Status   string `json:"status"`
		Progress string `json:"progress"`
		URL      string `json:"url"`
	} `json:"work_sessions"`
}

func taskStatus(source, message, status string) string {
	if source == message {
		if header := taskHeading.FindStringSubmatch(message); len(header) > 0 && header[1] != "In progress" {
			return strings.ToLower(header[1])
		}
		return status
	}
	before, after := taskHeading.FindStringSubmatch(source), taskHeading.FindStringSubmatch(message)
	if len(before) == 0 || before[1] != "In progress" || len(after) == 0 || after[1] == "In progress" {
		return ""
	}
	if strings.Replace(source, before[0], after[0], 1) != message {
		return ""
	}
	return strings.ToLower(after[1])
}

func (p *Plugin) nativeTask(post *model.Post) *mobileTask {
	if post == nil {
		return nil
	}
	identity, ok := propertyMap(post.Props["openclaw_mattermost"])
	if !ok || identity["version"] != float64(1) || identity["kind"] != "task_progress" ||
		identity["channelId"] != post.ChannelId ||
		!(identity["threadId"] == post.RootId || (identity["threadId"] == nil && post.RootId == "")) {
		return nil
	}
	raw, err := json.Marshal(post.Props["openclaw_task_progress"])
	if err != nil || len(raw) > 128*1024 {
		return nil
	}
	var card mobileTask
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return nil
	}
	if _, ok := payload["hidden_work_sessions"].(float64); !ok {
		return nil
	}
	for _, key := range []string{"steps", "work_sessions", "hidden_work_sessions"} {
		if _, exists := payload[key]; !exists {
			return nil
		}
	}
	for _, key := range []string{"title", "explanation"} {
		if value, exists := payload[key]; exists {
			if _, ok := value.(string); !ok {
				return nil
			}
		}
	}
	for key, required := range map[string]string{"steps": "step", "work_sessions": "label"} {
		if rows, ok := payload[key].([]any); ok {
			for _, row := range rows {
				value, ok := propertyMap(row)
				if !ok {
					return nil
				}
				if _, ok := value[required].(string); !ok {
					return nil
				}
				if progress, exists := value["progress"]; key == "work_sessions" && exists {
					if _, ok := progress.(string); !ok {
						return nil
					}
				}
			}
		}
	}
	if json.Unmarshal(raw, &card) != nil || card.Version != 1 || len(card.Source) > 65536 ||
		!taskHeading.MatchString(card.Source) || len(card.Title) > 1500 || len(card.Explanation) > 6000 ||
		len(card.Steps) > 50 || len(card.Work) > 5 || card.Hidden < 0 || card.Hidden > 1_000_000 {
		return nil
	}
	if !oneOf(card.Status, "in_progress", "completed", "incomplete", "failed", "cancelled") {
		return nil
	}
	card.Status = taskStatus(card.Source, post.Message, card.Status)
	if card.Status == "" {
		return nil
	}
	for _, step := range card.Steps {
		if len(step.Step) > 1500 || !oneOf(step.Status, "pending", "in_progress", "completed") {
			return nil
		}
	}
	for _, work := range card.Work {
		if len(work.Label) > 1500 || len(work.Progress) > 1500 || len(work.URL) > 4096 ||
			!oneOf(work.Status, "queued", "running", "completed", "failed", "cancelled") {
			return nil
		}
	}
	if !p.isAllowedBot(post.UserId) {
		return nil
	}
	return &card
}

func oneOf(value string, values ...string) bool {
	for _, allowed := range values {
		if value == allowed {
			return true
		}
	}
	return false
}

func emptyTaskAttachments(value any) bool {
	raw, err := json.Marshal(value)
	return err == nil && (string(raw) == "null" || string(raw) == "[]")
}

// An empty persisted attachment slot makes PreparePostForClient build the native
// embed before consumption hooks. With the companion disabled it displays no
// duplicate checklist. Metadata returned by consumption hooks is discarded.
func (p *Plugin) prepareNativeTask(post *model.Post) *model.Post {
	if p.nativeTask(post) == nil || !emptyTaskAttachments(post.Props["attachments"]) {
		return post
	}
	copy := post.Clone()
	copy.Type = taskProgressPostType
	copy.DelProp(taskMobileProp)
	copy.AddProp("attachments", []any{})
	return copy
}

func taskMobileHeading(message string) string {
	return strings.TrimSuffix(taskHeading.FindString(message), "\n")
}

func (p *Plugin) MessagesWillBeConsumed(posts []*model.Post) []*model.Post {
	out := make([]*model.Post, len(posts))
	for i, post := range posts {
		out[i] = post
		if post == nil {
			continue
		}
		if _, exists := post.Props["attachments"]; !exists || !emptyTaskAttachments(post.Props["attachments"]) {
			continue
		}
		card := p.nativeTask(post)
		if card == nil {
			continue
		}
		copy := post.Clone()
		copy.Message = taskMobileHeading(post.Message)
		copy.AddProp(taskMobileProp, map[string]any{"version": float64(1), "source_message": post.Message})
		copy.AddProp("attachments", []any{nativeTaskAttachment(card)})
		out[i] = copy
	}
	return out
}

// Projected reads can be sent back by clients. Restore only the exact projection
// of the current stored post (or its exact recovery terminal-heading edit).
// Stale projections are rejected rather than erasing a newer canonical checklist.
func (p *Plugin) restoreTaskProjection(post, old *model.Post) (*model.Post, string) {
	marker, exists := post.Props[taskMobileProp]
	if !exists {
		return post, ""
	}
	value, ok := propertyMap(marker)
	source, _ := value["source_message"].(string)
	if !ok || value["version"] != float64(1) || old == nil || source != old.Message ||
		p.nativeTask(old) == nil || !emptyTaskAttachments(old.Props["attachments"]) ||
		!reflect.DeepEqual(post.Props["openclaw_task_progress"], old.Props["openclaw_task_progress"]) ||
		!reflect.DeepEqual(post.Props["openclaw_mattermost"], old.Props["openclaw_mattermost"]) {
		return nil, "Task card changed; reload before editing its projected presentation."
	}
	canonical := source
	if post.Message != source {
		heading := taskMobileHeading(post.Message)
		if post.Message != heading || heading == "" {
			// Explicit full-message edits remain authoritative.
			copy := post.Clone()
			copy.DelProp(taskMobileProp)
			copy.AddProp("attachments", []any{})
			return copy, ""
		}
		canonical = heading + strings.TrimPrefix(source, taskMobileHeading(source))
		if taskStatus(source, canonical, "in_progress") == "" {
			return nil, "Unsupported task card projection edit."
		}
	}
	copy := post.Clone()
	copy.Message = canonical
	copy.DelProp(taskMobileProp)
	copy.AddProp("attachments", []any{})
	return copy, ""
}

func nativeTaskAttachment(card *mobileTask) map[string]any {
	active := card.Status == "in_progress"
	labels := map[string]string{
		"in_progress": "Working", "completed": "Completed", "incomplete": "Incomplete",
		"failed": "Failed", "cancelled": "Cancelled", "pending": "Pending", "queued": "Queued", "running": "Running",
	}
	symbol := func(status string) string {
		switch status {
		case "completed":
			return "✓"
		case "failed":
			return "✕"
		case "cancelled":
			return "−"
		case "in_progress", "running":
			if active {
				return "▶"
			}
		}
		return "○"
	}
	// Labels are plain text in the web card. Escape Markdown syntax here so a
	// label cannot introduce images, extra links or forged checklist formatting.
	plain := func(text string) string {
		text = strings.Join(strings.Fields(text), " ")
		return taskMarkdown.ReplaceAllString(text, "\\$1")
	}
	done := 0
	fields := []any{}
	for _, step := range card.Steps {
		if step.Status == "completed" {
			done++
		}
		fields = append(fields, map[string]any{"short": false, "value": symbol(step.Status) + " " + plain(step.Step)})
	}
	for i, work := range card.Work {
		label := plain(work.Label)
		if u, err := url.Parse(work.URL); err == nil && (u.Scheme == "http" || u.Scheme == "https") &&
			u.Host != "" && u.User == nil {
			// Encode Markdown delimiters even in an otherwise valid HTTP URL.
			link := strings.NewReplacer("(", "%28", ")", "%29", "<", "%3C", ">", "%3E").Replace(u.String())
			label = "[" + label + "](" + link + ")"
		}
		status := work.Status
		if !active && oneOf(status, "running", "queued") {
			status = "pending"
		}
		field := map[string]any{"short": false, "value": symbol(work.Status) + " " + label + " · " + labels[status]}
		if i == 0 {
			field["title"] = "Subtasks"
		}
		if work.Progress != "" {
			field["value"] = field["value"].(string) + "\n" + plain(work.Progress)
		}
		fields = append(fields, field)
	}
	if card.Hidden > 0 {
		fields = append(fields, map[string]any{"short": false, "value": fmt.Sprintf("%d additional subtasks tracked", card.Hidden)})
	}
	summary := fmt.Sprintf("%d of %d steps completed", done, len(card.Steps))
	if !active {
		summary = labels[card.Status]
	}
	color := "primary"
	if card.Status == "completed" {
		color = "success"
	} else if card.Status == "failed" {
		color = "danger"
	} else if !active {
		color = "default"
	}
	return map[string]any{
		"fallback": "Task progress", "color": color, "title": plain(card.Title),
		"text": plain(card.Explanation), "fields": fields, "footer": summary,
	}
}
