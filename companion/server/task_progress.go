package main

import (
	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

const taskProgressPostType = "custom_openclaw_task"

// The server hook also covers a standard result post becoming a late-plan card.
// PostPatch cannot change Type, so the companion owns this presentation choice.
func (p *Plugin) styleTaskProgress(post *model.Post) *model.Post {
	if post == nil {
		return post
	}
	identity, identityOK := propertyMap(post.Props["openclaw_mattermost"])
	card, cardOK := propertyMap(post.Props["openclaw_task_progress"])
	if identityOK && cardOK &&
		identity["version"] == float64(1) && identity["kind"] == "task_progress" &&
		identity["channelId"] == post.ChannelId &&
		(identity["threadId"] == post.RootId || (identity["threadId"] == nil && post.RootId == "")) &&
		card["version"] == float64(1) && card["source_message"] == post.Message &&
		p.isAllowedBot(post.UserId) {
		copy := post.Clone()
		copy.Type = taskProgressPostType
		return copy
	}
	return post
}

func (p *Plugin) MessageWillBePosted(_ *plugin.Context, post *model.Post) (*model.Post, string) {
	return p.styleWorkDetails(p.prepareNativeTask(p.styleTaskProgress(post))), ""
}

func (p *Plugin) MessageWillBeUpdated(_ *plugin.Context, post, old *model.Post) (*model.Post, string) {
	post, workReason := p.restoreWorkProjection(post, old)
	if workReason != "" {
		return nil, workReason
	}
	restored, reason := p.restoreTaskProjection(post, old)
	if reason != "" {
		return nil, reason
	}
	// A final or identity handoff must not keep a custom work renderer merely
	// because PostPatch cannot change Type.
	if old != nil && old.Type == workDetailsPostType && !p.workDetails(restored) {
		restored = restored.Clone()
		restored.Type = ""
	}
	return p.styleWorkDetails(p.prepareNativeTask(p.styleTaskProgress(restored))), ""
}
