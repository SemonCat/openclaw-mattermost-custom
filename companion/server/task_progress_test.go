package main

import (
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
)

func taskPost() *model.Post {
	return &model.Post{
		Id: testPostID, UserId: testBotID, ChannelId: testChannelID, RootId: "root",
		Message: "#### Task progress · In progress\nReview PR",
		Props: model.StringInterface{
			"openclaw_mattermost": map[string]any{
				"version": float64(1), "kind": "task_progress",
				"channelId": testChannelID, "threadId": "root",
			},
			"openclaw_task_progress": map[string]any{
				"version": float64(1), "source_message": "#### Task progress · In progress\nReview PR",
			},
		},
	}
}

func TestTaskProgressPresentation(t *testing.T) {
	p, _ := newTestPlugin()
	post := taskPost()
	created, reason := p.MessageWillBePosted(nil, post)
	if reason != "" || created.Type != taskProgressPostType || post.Type != "" {
		t.Fatal("eligible creation must gain task presentation without mutating input")
	}
	// A prior result can be standard REST or companion streaming. Both must
	// become a card on the same identity when a late plan claims the older post.
	for _, previousType := range []string{"", postType} {
		old := post.Clone()
		old.Type = previousType
		updated, reason := p.MessageWillBeUpdated(nil, post, old)
		if reason != "" || updated.Type != taskProgressPostType || updated.Id != old.Id {
			t.Fatalf("handoff from %q lost presentation or identity", previousType)
		}
	}
}

func TestTaskProgressPresentationAdmission(t *testing.T) {
	for name, change := range map[string]func(*model.Post){
		"human":        func(p *model.Post) { p.UserId = "human" },
		"foreign bot":  func(p *model.Post) { p.UserId = "stranger" },
		"channel":      func(p *model.Post) { p.ChannelId = "foreign" },
		"thread":       func(p *model.Post) { p.RootId = "foreign" },
		"stale source": func(p *model.Post) { p.Message = "Edited elsewhere" },
		"no data":      func(p *model.Post) { delete(p.Props, "openclaw_task_progress") },
		"result": func(p *model.Post) {
			p.Props["openclaw_mattermost"].(map[string]any)["kind"] = "turn_result"
		},
	} {
		t.Run(name, func(t *testing.T) {
			p, _ := newTestPlugin()
			post := taskPost()
			change(post)
			updated, reason := p.MessageWillBeUpdated(nil, post, nil)
			if reason != "" || updated.Type != "" || updated.Message != post.Message {
				t.Fatal("ineligible post must retain its normal presentation and text")
			}
		})
	}
}
