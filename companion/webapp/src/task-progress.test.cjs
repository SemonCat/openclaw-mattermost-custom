const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sandbox = {window: {}, URL};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'task-progress.js'), 'utf8'), sandbox);
const {readCard, renderCard} = sandbox.window.OpenClawTaskProgress;
const React = {createElement: (tag, props, ...children) => ({tag, props, children})};
const message = '#### Task progress · In progress\nReview PR\n\n- [x] Read diff\n- [ ] **Run tests**';
function makePost(status = 'in_progress') {
    return {
        id: 'card', channel_id: 'channel', root_id: 'root', message, update_at: 1793332800000,
        props: {
            openclaw_mattermost: {version: 1, kind: 'task_progress', channelId: 'channel', threadId: 'root'},
            openclaw_task_progress: {
                version: 1, source_message: message, status, title: 'Review PR',
                steps: [{step: 'Read diff', status: 'completed'}, {step: 'Run tests', status: 'in_progress'}],
                work_sessions: [{label: 'Build simulator', url: 'https://dev.example/session', status: 'running'}],
                hidden_work_sessions: 0,
            },
        },
    };
}
function nodes(tree, predicate) {
    if (!tree || typeof tree !== 'object') return [];
    return [...(predicate(tree) ? [tree] : []), ...(tree.children || []).flatMap((c) => nodes(c, predicate))];
}
function text(tree) {
    return typeof tree === 'string' ? tree : (tree?.children || []).map(text).join('');
}

test('renders checklist status, safe session link, summary and server update time', () => {
    const tree = renderCard(React, makePost(), (text) => text);
    assert.match(text(tree), /Review PRWorkingRead diffRun tests/);
    assert.match(text(tree), /1 of 2 steps completed/);
    assert.equal(nodes(tree, (n) => n.props?.className?.includes('oc-task-icon--spin')).length, 2);
    assert.equal(nodes(tree, (n) => n.tag === 'a')[0].props.href, 'https://dev.example/session');
    assert.equal(nodes(tree, (n) => n.tag === 'time')[0].props.dateTime, new Date(1793332800000).toISOString());
});

test('terminal statuses stay truthful and stop all running indicators', () => {
    for (const [status, summary] of [
        ['completed', 'All steps completed'], ['failed', 'Task failed'],
        ['cancelled', 'Task cancelled'], ['incomplete', 'Finished with unfinished steps'],
    ]) {
        const post = makePost(status);
        if (status === 'completed') post.props.openclaw_task_progress.steps[1].status = 'completed';
        const tree = renderCard(React, post, (text) => text);
        assert.match(text(tree), new RegExp(summary));
        assert.equal(nodes(tree, (n) => n.props?.className?.includes('oc-task-icon--spin')).length, 0);
    }
});

test('accepts empty arrays encoded as null by Mattermost plugin RPC', () => {
    const post = makePost();
    post.props.openclaw_task_progress.steps = null;
    post.props.openclaw_task_progress.work_sessions = null;
    const tree = renderCard(React, post, (text) => text);
    assert.match(text(tree), /Work in progress/);
    assert.equal(nodes(tree, (n) => n.tag === 'li').length, 0);
});

test('honors restart recovery terminal-only edits without using stale active status', () => {
    for (const status of ['Failed', 'Cancelled', 'Incomplete', 'Completed']) {
        const post = makePost();
        post.message = message.replace('In progress', status);
        assert.equal(readCard(post).status, status.toLowerCase());
        const tree = renderCard(React, post, (text) => text);
        assert.equal(nodes(tree, (n) => n.props?.className?.includes('oc-task-icon--spin')).length, 0);
    }
});

test('renders validated native projections once, including recovery terminal overrides', () => {
    for (const status of ['In progress', 'Incomplete', 'Failed', 'Cancelled', 'Completed']) {
        const post = makePost();
        post.message = `#### Task progress · ${status}`;
        post.props.openclaw_task_mobile = {
            version: 1, source_message: message.replace('In progress', status),
        };
        const tree = renderCard(React, post, (value) => value);
        assert.equal(nodes(tree, (n) => n.props?.className === 'oc-task-card').length, 1);
        assert.equal(text(tree).split('Read diff').length - 1, 1);
        if (status !== 'In progress') {
            assert.equal(nodes(tree, (n) => n.props?.className?.includes('oc-task-icon--spin')).length, 0);
        }
    }
    for (const marker of [
        {version: 2, source_message: message},
        {version: 1, source_message: message + '\nStale'},
        {version: 1, source_message: 'Foreign source'},
    ]) {
        const post = makePost();
        post.message = '#### Task progress · In progress';
        post.props.openclaw_task_mobile = marker;
        assert.equal(readCard(post), null);
    }
});

test('falls back for changed content, foreign identity, unknown versions and malformed data', () => {
    for (const mutate of [
        (p) => { p.message += '\nChanged'; },
        (p) => { p.root_id = 'foreign'; },
        (p) => { p.props.openclaw_mattermost.kind = 'turn_result'; },
        (p) => { p.props.openclaw_task_progress.version = 2; },
        (p) => { p.props.openclaw_task_progress.steps = [{step: {}, status: 'completed'}]; },
        (p) => { p.props.openclaw_task_progress.work_sessions[0].progress = {}; },
        (p) => { p.props.openclaw_task_progress.steps = Array(51).fill({step: 'A', status: 'pending'}); },
        (p) => { p.props.openclaw_task_progress.hidden_work_sessions = null; },
        (p) => { p.props.openclaw_task_progress.steps = [{status: 'completed'}]; },
        (p) => { p.props.openclaw_task_progress.steps = [{step: null, status: 'completed'}]; },
        (p) => { p.props.openclaw_task_progress.work_sessions = [{status: 'running'}]; },
        (p) => { p.props.openclaw_task_progress.work_sessions = [{label: null, status: 'running'}]; },
        (p) => { p.props.openclaw_task_progress.work_sessions[0].progress = null; },
    ]) {
        const post = makePost();
        mutate(post);
        assert.equal(renderCard(React, post, (text) => text), null);
    }
});

test('renders untrusted labels as text and rejects executable session links', () => {
    const post = makePost();
    const card = post.props.openclaw_task_progress;
    card.steps[0].step = '<img src=x onerror=alert(1)>';
    card.work_sessions[0].url = 'javascript:alert(1)';
    const tree = renderCard(React, post, (text) => text);
    assert.match(text(tree), /<img src=x onerror=alert\(1\)>/);
    assert.equal(nodes(tree, (n) => n.tag === 'a').length, 0);
    assert.equal(nodes(tree, (n) => n.props?.dangerouslySetInnerHTML).length, 0);
});

test('plugin registers a dedicated task renderer and includes its CSS in the shipped bundle', () => {
    const bundle = fs.readFileSync(path.join(__dirname, '../dist/main.js'), 'utf8');
    const browser = {OpenClawStreamState: {EventStore: class {}}, registerPlugin: (_, p) => { browser.plugin = p; }};
    vm.runInNewContext(bundle, {window: browser, URL});
    const types = [];
    browser.plugin.initialize({
        registerPostTypeComponent: (type) => types.push(type),
        registerWebSocketEventHandler: () => {}, registerReconnectHandler: () => {},
    }, {getState: () => ({})});
    assert.deepEqual(types, ['custom_openclaw_stream', 'custom_openclaw_task']);
    assert.match(browser.OpenClawTaskProgressCSS, /prefers-reduced-motion/);
    assert.match(browser.OpenClawTaskProgressCSS, /center-channel-color/);
});
