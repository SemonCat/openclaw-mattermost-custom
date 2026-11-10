(function taskProgressModule() {
    const statuses = new Set(['in_progress', 'completed', 'incomplete', 'failed', 'cancelled']);
    const stepStatuses = new Set(['pending', 'in_progress', 'completed']);
    const workStatuses = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
    const labels = {
        in_progress: 'Working', completed: 'Completed', incomplete: 'Incomplete',
        failed: 'Failed', cancelled: 'Cancelled', pending: 'Pending',
        queued: 'Queued', running: 'Running',
    };

    function safeURL(value) {
        try {
            const url = new URL(value);
            return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
        } catch {
            return undefined;
        }
    }

    function readCard(post) {
        const identity = post.props?.openclaw_mattermost;
        const card = post.props?.openclaw_task_progress;
        // Mattermost's Go plugin RPC round trip encodes empty arrays as null.
        const steps = card?.steps === null ? [] : card?.steps;
        const workSessions = card?.work_sessions === null ? [] : card?.work_sessions;
        if (identity?.version !== 1 || !['task_progress', 'subagent_progress'].includes(identity.kind) ||
            identity.channelId !== post.channel_id ||
            (identity.threadId || '') !== (post.root_id || '') ||
            card?.version !== 1 || !statuses.has(card.status) ||
            typeof card.source_message !== 'string' || typeof post.message !== 'string' ||
            (card.title !== undefined && typeof card.title !== 'string') ||
            (card.explanation !== undefined && typeof card.explanation !== 'string') ||
            !Array.isArray(steps) || steps.length > 50 ||
            (identity.kind === 'subagent_progress' && steps.length > 0) ||
            !steps.every((step) => typeof step?.step === 'string' && stepStatuses.has(step.status)) ||
            !Array.isArray(workSessions) || workSessions.length > 5 ||
            !workSessions.every((work) => typeof work?.label === 'string' &&
                workStatuses.has(work.status) &&
                (work.progress === undefined || typeof work.progress === 'string')) ||
            !Number.isSafeInteger(card.hidden_work_sessions) || card.hidden_work_sessions < 0) {
            return null;
        }
        let status = card.status;
        let message = post.message;
        const projection = post.props?.openclaw_task_mobile;
        if (projection !== undefined) {
            const source = projection?.source_message;
            if (projection?.version !== 1 || typeof source !== 'string' || source.length > 65536 ||
                source.match(/^#### Task progress · (In progress|Completed|Incomplete|Failed|Cancelled)(?=\n|$)/)?.[0] !== message) {
                return null;
            }
            message = source;
        }
        if (card.source_message !== message) {
            // Restart recovery edits only the durable terminal heading. Accept that
            // exact edit, but fall back to Markdown for any other content change.
            const header = /^#### Task progress · (Completed|Incomplete|Failed|Cancelled)(?=\n|$)/;
            const match = message.match(header);
            if (!match || card.source_message.replace(/^#### Task progress · In progress(?=\n|$)/,
                match[0]) !== message) {
                return null;
            }
            status = match[1].toLowerCase();
        }
        const counts = card.work_session_counts;
        if (counts !== undefined && (!counts || !['queued', 'running', 'completed', 'failed', 'cancelled']
            .every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0))) return null;
        return {...card, status, steps, work_sessions: workSessions, hasPlan: identity.kind === 'task_progress'};
    }

    function renderCard(React, post, markdown) {
        const card = readCard(post);
        if (!card) {
            return null;
        }
        const h = React.createElement;
        const active = card.status === 'in_progress';
        const done = card.steps.filter((step) => step.status === 'completed').length;
        let summary = card.status === 'completed'
            ? (card.steps.length ? 'All steps completed' : 'Task completed')
            : card.status === 'incomplete' ? 'Finished with unfinished steps'
                : card.status === 'failed' ? 'Task failed'
                    : card.status === 'cancelled' ? 'Task cancelled'
                        : card.steps.length ? `${done} of ${card.steps.length} steps completed` : 'Work in progress';
        if (!active && card.steps.length) summary += ` · ${done} of ${card.steps.length} steps completed`;
        const counts = card.work_session_counts || card.work_sessions.reduce((result, work) => {
            result[work.status] = (result[work.status] || 0) + 1;
            return result;
        }, {});
        const childSummary = ['running', 'queued', 'completed', 'failed', 'cancelled']
            .filter((status) => counts[status])
            .map((status) => `${counts[status]} ${status}`).join(' · ');

        function icon(status) {
            const spinning = active && ['in_progress', 'running'].includes(status);
            const effective = !active && ['in_progress', 'running', 'queued'].includes(status)
                ? 'pending' : status;
            const path = effective === 'completed' ? 'M5 10l3 3 7-7'
                : effective === 'failed' ? 'M6 6l8 8M14 6l-8 8'
                    : effective === 'cancelled' ? 'M6 10h8' : null;
            return h('span', {
                className: `oc-task-icon oc-task-icon--${effective}${spinning ? ' oc-task-icon--spin' : ''}`,
                role: 'img', 'aria-label': labels[effective],
            }, path ? h('svg', {viewBox: '0 0 20 20', 'aria-hidden': true, focusable: 'false'},
                h('path', {d: path, fill: 'none', stroke: 'currentColor', strokeWidth: 2.2,
                    strokeLinecap: 'round', strokeLinejoin: 'round'})) : null);
        }

        function workRow(work, index) {
            const url = safeURL(work.url);
            return h('li', {className: 'oc-task-row oc-task-row--subtask', key: index},
                icon(work.status),
                h('div', {className: 'oc-task-row-content'},
                    url ? h('a', {href: url, target: '_blank', rel: 'noopener noreferrer'}, work.label) : work.label,
                    h('span', {className: 'oc-task-work-status'}, ` · ${labels[work.status]}`),
                    work.progress ? h('div', {className: 'oc-task-work-progress'}, work.progress) : null));
        }

        const updatedAt = post.update_at || post.create_at;
        const updated = Number.isFinite(updatedAt) && updatedAt > 0 ? new Date(updatedAt) : null;
        return h('details', {className: 'oc-task-card', key: post.id, 'aria-label': card.title || 'Task progress'},
            h('summary', {className: 'oc-task-heading'},
                h('h3', {className: 'oc-task-title'}, card.title || (card.hasPlan ? 'Task progress' : 'Subagents')),
                h('span', {className: `oc-task-status oc-task-status--${card.status}`}, labels[card.status]),
                card.hasPlan || !active || !childSummary
                    ? h('span', {className: 'oc-task-summary', role: 'status'}, summary) : null,
                childSummary ? h('span', {className: 'oc-task-child-summary'}, childSummary) : null,
                h('span', {className: 'oc-card-hint', 'aria-hidden': true})),
            card.hasPlan && (card.explanation || card.steps.length) ? h('section', {className: 'oc-task-section'},
                h('h4', {className: 'oc-task-subtitle'}, 'Plan'),
                card.explanation ? h('div', {className: 'oc-task-explanation'}, markdown(card.explanation)) : null,
            card.steps.length ? h('ol', {className: 'oc-task-list'},
                ...card.steps.map((step, index) => h('li', {
                    className: `oc-task-row${active && step.status === 'in_progress' ? ' oc-task-row--active' : ''}`,
                    key: index,
                }, icon(step.status), h('span', {className: 'oc-task-row-content'}, step.step)))) : null) : null,
            card.work_sessions.length ? h('section', {className: 'oc-task-section'},
                h('h4', {className: 'oc-task-subtitle'}, 'Subagents'),
                h('ul', {className: 'oc-task-list'}, ...card.work_sessions.map(workRow)),
                card.hidden_work_sessions ? h('p', {className: 'oc-task-overflow'},
                    `${card.hidden_work_sessions} additional subtasks tracked`) : null) : null,
            updated ? h('footer', {className: 'oc-task-footer'},
                'Updated ', h('time', {dateTime: updated.toISOString(), title: updated.toLocaleString()},
                    updated.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}))) : null);
    }

    function workSource(post) {
        const identity = post.props?.openclaw_mattermost;
        const details = post.props?.openclaw_work_details;
        const projection = post.props?.openclaw_work_projection;
        const message = projection?.version === 1 && post.message === 'Work details'
            ? projection.source_message : post.message;
        return identity?.version === 1 && identity.kind === 'turn_result' &&
            identity.channelId === post.channel_id &&
            (identity.threadId || '') === (post.root_id || '') &&
            details?.version === 1 && typeof message === 'string' &&
            message === details.source_message ? message : null;
    }

    function renderWork(React, post, message, markdown) {
        if (workSource(post) === null) return markdown(message);
        // No open prop: the browser owns this reader's disclosure state across
        // React updates. Neither toggling nor progress updates write to the post.
        return React.createElement('details', {className: 'oc-work-details', key: post.id},
            React.createElement('summary', {className: 'oc-task-heading'},
                React.createElement('h3', {className: 'oc-task-title'}, 'Activity'),
                React.createElement('span', {className: 'oc-card-hint', 'aria-hidden': true})),
            React.createElement('div', {className: 'oc-activity-log'}, markdown(message)));
    }

    window.OpenClawTaskProgress = {readCard, renderCard, workSource, renderWork};
}());
