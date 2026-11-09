package main

import (
	"reflect"
	"strings"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
)

func TestNativeDisclosureVisibleTitleCount(t *testing.T) {
	for _, tc := range []struct {
		name  string
		post  *model.Post
		title string
		label string
	}{
		{"task", mobilePost(), "Task progress · In progress", "Plan details"},
		{"work", workPost(), "Work details", "Activity"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, _ := newTestPlugin()
			stored, reason := p.MessageWillBePosted(nil, tc.post)
			if reason != "" {
				t.Fatal(reason)
			}
			projected := wirePost(p.MessagesWillBeConsumed([]*model.Post{stored})[0])
			block := projected.Props["mm_blocks"].([]any)[0].(map[string]any)
			header := block["header"].([]any)[0].(map[string]any)["text"].(string)
			content := block["content"].([]any)[0].(map[string]any)["text"].(string)
			// Official mobile renders the outer Message and selected Blocks
			// separately. The attachment is fallback, not another visible copy.
			count := strings.Count(projected.Message, tc.title) +
				strings.Count(header, tc.title) + strings.Count(content, tc.title)
			if count != 1 {
				t.Fatalf("expanded visible title count = %d, want 1; outer Message=%q; block header=%q; block content=%q",
					count, projected.Message, header, content)
			}
			if header != tc.label || strings.Contains(header, tc.title) {
				t.Fatalf("disclosure label = %q, want distinct action label %q", header, tc.label)
			}
			if block["collapsed"] != true {
				t.Fatal("presentation must retain the native initially collapsed disclosure")
			}
		})
	}
}

func TestNativeTaskDisclosurePreservesDetailsAndFallback(t *testing.T) {
	// The extra leading blank line, authored repeated heading, whitespace and
	// Unicode must survive; remove just the generated heading and one newline.
	body := "\nReview PR\n\nPreserve **explanation** 界  \n\n- [x] Read diff\n- [ ] Run tests\n\n" +
		"Subtasks\n[Child](https://example.test/child) · Running\nReviewing source\n\n" +
		"#### Task progress · In progress\nAn authored heading stays."
	for _, status := range []string{"In progress", "Completed", "Incomplete", "Failed", "Cancelled"} {
		t.Run(status, func(t *testing.T) {
			p, _ := newTestPlugin()
			input := mobilePost()
			input.Message = "#### Task progress · In progress\n" + body
			input.Props["openclaw_task_progress"].(map[string]any)["source_message"] = input.Message
			input.CreateAt, input.UpdateAt, input.EditAt = 100, 200, 200
			stored, reason := p.MessageWillBePosted(nil, input)
			if reason != "" {
				t.Fatal(reason)
			}
			// Recovery edits only the leading status, leaving the original
			// structured source and every authored detail untouched.
			stored.Message = strings.Replace(stored.Message, "In progress", status, 1)
			before := wirePost(stored)
			projected := wirePost(p.MessagesWillBeConsumed([]*model.Post{stored})[0])
			block := projected.Props["mm_blocks"].([]any)[0].(map[string]any)
			content := block["content"].([]any)[0].(map[string]any)["text"].(string)
			if projected.Message != "#### Task progress · "+status || content != body ||
				projected.CreateAt != stored.CreateAt || projected.UpdateAt != stored.UpdateAt ||
				projected.EditAt != stored.EditAt || !reflect.DeepEqual(before, wirePost(stored)) {
				t.Fatal("read projection must preserve outer status, edit metadata, storage and every detail byte")
			}
			// Blocks-disabled clients still receive the existing full native
			// attachment presentation alongside the complete outer heading.
			fallback := wirePost(stored)
			fallback.AddProp("attachments", []any{nativeTaskAttachment(p.nativeTask(stored))})
			if !reflect.DeepEqual(projected.Props["attachments"], wirePost(fallback).Props["attachments"]) {
				t.Fatal("native attachment fallback changed")
			}
			roundtrip, reason := p.MessageWillBeUpdated(nil, projected, stored)
			if reason != "" || roundtrip.Message != stored.Message || roundtrip.Props["mm_blocks"] != nil {
				t.Fatal("projected writes must restore the complete canonical task, including heading")
			}
		})
	}
}

func TestNativeWorkDisclosureKeepsAuthoredHeading(t *testing.T) {
	p, _ := newTestPlugin()
	input := workPost()
	input.Message = "Work details\n\nPublished commentary 界  \nTool summary"
	input.Props["openclaw_work_details"].(map[string]any)["source_message"] = input.Message
	input.CreateAt, input.UpdateAt, input.EditAt = 100, 200, 200
	stored, reason := p.MessageWillBePosted(nil, input)
	if reason != "" {
		t.Fatal(reason)
	}
	before := wirePost(stored)
	projected := wirePost(p.MessagesWillBeConsumed([]*model.Post{stored})[0])
	block := projected.Props["mm_blocks"].([]any)[0].(map[string]any)
	attachment := projected.Props["attachments"].([]any)[0].(map[string]any)
	if projected.Message != "Work details" ||
		block["header"].([]any)[0].(map[string]any)["text"] != "Activity" ||
		block["content"].([]any)[0].(map[string]any)["text"] != input.Message ||
		attachment["text"] != input.Message || attachment["fallback"] != input.Message ||
		projected.CreateAt != stored.CreateAt || projected.UpdateAt != stored.UpdateAt ||
		projected.EditAt != stored.EditAt || !reflect.DeepEqual(before, wirePost(stored)) {
		t.Fatal("work projection must retain authored content, fallback, metadata and storage exactly")
	}
}

func TestNativeDisclosureOversizedFallbackUnchanged(t *testing.T) {
	for _, kind := range []string{"task", "work"} {
		t.Run(kind, func(t *testing.T) {
			p, _ := newTestPlugin()
			input := mobilePost()
			prop := "openclaw_task_progress"
			if kind == "work" {
				input, prop = workPost(), "openclaw_work_details"
			}
			input.Message += strings.Repeat("界", 5001)
			input.Props[prop].(map[string]any)["source_message"] = input.Message
			stored, reason := p.MessageWillBePosted(nil, input)
			if reason != "" {
				t.Fatal(reason)
			}
			projected := wirePost(p.MessagesWillBeConsumed([]*model.Post{stored})[0])
			if stored.Message != input.Message || projected.Props["mm_blocks"] != nil {
				t.Fatal("oversized content must retain canonical storage and existing non-Blocks fallback")
			}
			if kind == "work" && projected.Message != input.Message {
				t.Fatal("oversized work must retain plain Markdown")
			}
			if kind == "task" && (projected.Message != "#### Task progress · In progress" ||
				projected.Props["attachments"] == nil) {
				t.Fatal("oversized task must retain outer heading and native attachment fallback")
			}
		})
	}
}

func TestNativeTaskHeadingOnlyFallback(t *testing.T) {
	for _, suffix := range []string{"", "\n", "\n ", "\n\n"} {
		for _, status := range []string{"In progress", "Completed", "Incomplete", "Failed", "Cancelled"} {
			t.Run(status+"/"+strings.ReplaceAll(suffix, "\n", "newline"), func(t *testing.T) {
				p, _ := newTestPlugin()
				input := mobilePost()
				input.Message = "#### Task progress · In progress" + suffix
				input.Props["openclaw_task_progress"].(map[string]any)["source_message"] = input.Message
				stored, reason := p.MessageWillBePosted(nil, input)
				if reason != "" {
					t.Fatal(reason)
				}
				stored.Message = strings.Replace(stored.Message, "In progress", status, 1)
				projected := wirePost(p.MessagesWillBeConsumed([]*model.Post{stored})[0])
				if projected.Message != "#### Task progress · "+status ||
					projected.Props[taskMobileProp].(map[string]any)["source_message"] != stored.Message ||
					projected.Props["attachments"] == nil {
					t.Fatal("heading-only tasks must retain outer status, source and attachment fallback")
				}
				if suffix == "" || suffix == "\n" {
					if projected.Props["mm_blocks"] != nil {
						t.Fatal("no empty native text block or disclosure for heading-only tasks")
					}
				} else {
					block := projected.Props["mm_blocks"].([]any)[0].(map[string]any)
					if block["content"].([]any)[0].(map[string]any)["text"] != suffix[1:] {
						t.Fatal("authored whitespace must not be trimmed or treated as empty")
					}
				}
				roundtrip, reason := p.MessageWillBeUpdated(nil, projected, stored)
				if reason != "" || roundtrip.Message != stored.Message {
					t.Fatal("heading-only or whitespace details must roundtrip with exact source and status")
				}
			})
		}
	}
}
