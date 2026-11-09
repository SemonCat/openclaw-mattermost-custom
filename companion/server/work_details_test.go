package main

import (
	"strings"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
)

func workPost() *model.Post {
	post := taskPost()
	post.Message = "Published commentary\nTool summary"
	post.Props["openclaw_mattermost"].(map[string]any)["kind"] = "turn_result"
	delete(post.Props, "openclaw_task_progress")
	post.AddProp("openclaw_work_details", map[string]any{"version": float64(1), "source_message": post.Message})
	return post
}

func TestWorkProjectionFallbackAndFinalPromotion(t *testing.T) {
	p, _ := newTestPlugin()
	for _, transport := range []string{"", postType} {
		input := workPost()
		input.Type = transport
		stored, reason := p.MessageWillBePosted(nil, input)
		if reason != "" || stored.Message != input.Message {
			t.Fatal("creation must retain canonical Markdown")
		}
		projected := wirePost(p.MessagesWillBeConsumed([]*model.Post{stored})[0])
		block := projected.Props["mm_blocks"].([]any)[0].(map[string]any)
		attachment := projected.Props["attachments"].([]any)[0].(map[string]any)
		if projected.Message != "Work details" || block["type"] != "collapsible" || block["collapsed"] != true ||
			attachment["text"] != input.Message || stored.Message != input.Message {
			t.Fatal("native collapse must keep complete disabled-Blocks fallback and canonical storage")
		}
		roundtrip, reason := p.MessageWillBeUpdated(nil, projected, stored)
		if reason != "" || roundtrip.Message != input.Message || roundtrip.Props["mm_blocks"] != nil ||
			roundtrip.Props["openclaw_work_projection"] != nil {
			t.Fatal("projected writes must restore canonical text and remove read presentation")
		}
		final := stored.Clone()
		final.DelProp("openclaw_work_details")
		updated, reason := p.MessageWillBeUpdated(nil, final, stored)
		if reason != "" || updated.Message != input.Message || updated.Type == workDetailsPostType ||
			p.MessagesWillBeConsumed([]*model.Post{updated})[0].Message != input.Message {
			t.Fatal("same-text final promotion must display the answer directly")
		}
	}
}

func TestWorkProjectionAdmissionAndStaleWrites(t *testing.T) {
	p, _ := newTestPlugin()
	for _, mutate := range []func(*model.Post){
		func(post *model.Post) { post.UserId = "human" },
		func(post *model.Post) { post.RootId = "foreign" },
		func(post *model.Post) { post.Message += "\nexternal edit" },
		func(post *model.Post) {
			post.Message = strings.Repeat("界", 5001)
			post.Props["openclaw_work_details"].(map[string]any)["source_message"] = post.Message
		},
		func(post *model.Post) { post.AddProp("attachments", []any{map[string]any{"text": "foreign"}}) },
	} {
		post := workPost()
		mutate(post)
		if p.styleWorkDetails(post) != post || p.projectWorkDetails(post) != post {
			t.Fatal("foreign, oversized or stale content must retain its existing presentation")
		}
	}
	stored := p.styleWorkDetails(workPost())
	projected := wirePost(p.projectWorkDetails(stored))
	newer := stored.Clone()
	newer.Message += "\nNew progress"
	if _, reason := p.MessageWillBeUpdated(nil, projected, newer); reason == "" {
		t.Fatal("a stale projected write must not overwrite newer canonical progress")
	}
}
