package main

import (
	"reflect"

	"github.com/mattermost/mattermost/server/public/model"
)

const workDetailsPostType = "custom_openclaw_work"

func (p *Plugin) workDetails(post *model.Post) bool {
	if post == nil {
		return false
	}
	identity, ok := propertyMap(post.Props["openclaw_mattermost"])
	details, valid := propertyMap(post.Props["openclaw_work_details"])
	return ok && valid && identity["version"] == float64(1) && identity["kind"] == "turn_result" &&
		identity["channelId"] == post.ChannelId &&
		(identity["threadId"] == post.RootId || (identity["threadId"] == nil && post.RootId == "")) &&
		details["version"] == float64(1) && details["source_message"] == post.Message &&
		len(post.Message) > 0 && len(post.Message) <= 15000 && p.isAllowedBot(post.UserId)
}

func (p *Plugin) styleWorkDetails(post *model.Post) *model.Post {
	if !p.workDetails(post) || !emptyTaskAttachments(post.Props["attachments"]) {
		return post
	}
	copy := post.Clone()
	if copy.Type != postType {
		copy.Type = workDetailsPostType
	}
	copy.AddProp("attachments", []any{})
	return copy
}

// Native Blocks take precedence over attachments in supported clients. The
// attachment is the complete fallback when Blocks are disabled or unsupported.
// Only read projections change: stored Markdown stays canonical and lossless.
func collapsedWorkBlocks(header, content string) []any {
	return []any{map[string]any{
		"type": "collapsible", "collapsed": true,
		"header":  []any{map[string]any{"type": "text", "text": header}},
		"content": []any{map[string]any{"type": "text", "text": content}},
	}}
}

func (p *Plugin) projectWorkDetails(post *model.Post) *model.Post {
	if !p.workDetails(post) || !emptyTaskAttachments(post.Props["attachments"]) {
		return post
	}
	copy := post.Clone()
	copy.Message = "Work details"
	copy.AddProp("openclaw_work_projection", map[string]any{"version": float64(1), "source_message": post.Message})
	copy.AddProp("attachments", []any{map[string]any{"text": post.Message, "fallback": post.Message}})
	copy.AddProp("mm_blocks", collapsedWorkBlocks("Activity", post.Message))
	return copy
}

func (p *Plugin) restoreWorkProjection(post, old *model.Post) (*model.Post, string) {
	marker, exists := post.Props["openclaw_work_projection"]
	if !exists {
		return post, ""
	}
	value, ok := propertyMap(marker)
	source, _ := value["source_message"].(string)
	if !ok || value["version"] != float64(1) || old == nil || source != old.Message ||
		!p.workDetails(old) || !reflect.DeepEqual(post.Props["openclaw_work_details"], old.Props["openclaw_work_details"]) ||
		!reflect.DeepEqual(post.Props["openclaw_mattermost"], old.Props["openclaw_mattermost"]) {
		return nil, "Work details changed; reload before editing."
	}
	copy := post.Clone()
	if copy.Message == "Work details" {
		copy.Message = source
	}
	copy.DelProp("openclaw_work_projection")
	copy.DelProp("mm_blocks")
	copy.AddProp("attachments", []any{})
	return copy, ""
}
