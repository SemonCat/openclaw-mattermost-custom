const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../dist/stream-state.js'), 'utf8');
const sandbox = {Date, Map, Set, Number, Object, Array, Math};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const state = sandbox.OpenClawStreamState;

function makePost(overrides = {}) {
    return {
        id: 'post-1',
        channel_id: 'channel-1',
        root_id: '',
        type: 'custom_openclaw_stream',
        update_at: 100,
        message: 'durable response',
        props: {
            openclaw_mattermost: {version: 1, kind: 'turn_result', channelId: 'channel-1'},
            openclaw_stream: {version: 1, generation: 'generation-1'},
        },
        ...overrides,
    };
}

function makeSnapshot(overrides = {}) {
    return {
        post_id: 'post-1',
        channel_id: 'channel-1',
        root_id: '',
        generation: 'generation-1',
        seq: 1,
        message: 'live response',
        closed: false,
        updated_at: 101,
        expires_at: 500,
        ...overrides,
    };
}

test('uses an authorized active snapshot for the matching post generation', () => {
    const post = makePost();
    const snapshot = makeSnapshot();
    assert.equal(state.snapshotForPost(post, snapshot, 200).message, 'live response');
    assert.equal(state.messageForPost(post, snapshot, null, 200), 'live response');
});

test('falls back to persisted post text for foreign identity or generation', () => {
    const post = makePost();
    assert.equal(state.messageForPost(post, makeSnapshot({generation: 'other-generation'}), null, 200), 'durable response');
    assert.equal(state.messageForPost(post, makeSnapshot({channel_id: 'other-channel'}), null, 200), 'durable response');
});

test('durable REST edits win when the snapshot predates post.update_at', () => {
    const post = makePost({update_at: 110, message: 'checkpointed answer'});
    assert.equal(state.messageForPost(post, makeSnapshot({updated_at: 109}), null, 200), 'checkpointed answer');
});

test('uses persisted message after handoff removes turn-result eligibility', () => {
    const post = makePost({
        props: {
            openclaw_mattermost: {version: 1, kind: 'task_card', channelId: 'channel-1'},
            openclaw_stream: {version: 1, generation: 'generation-1'},
        },
    });
    assert.equal(state.messageForPost(post, makeSnapshot(), null, 200), 'durable response');
});

test('closed or expired snapshots fall back to persisted text', () => {
    const post = makePost();
    assert.equal(state.messageForPost(post, makeSnapshot({closed: true}), null, 200), 'durable response');
    assert.equal(state.messageForPost(post, makeSnapshot({expires_at: 200}), null, 200), 'durable response');
});

test('a fresher persisted REST post replaces a stale client copy', () => {
    const post = makePost({update_at: 100, message: 'old copy'});
    const persisted = makePost({update_at: 120, message: 'authoritative copy'});
    assert.equal(state.messageForPost(post, null, persisted, 200), 'authoritative copy');
});

test('a fresher persisted REST post fences stale snapshots despite a lagging client copy', () => {
    const post = makePost({update_at: 100, message: 'old copy'});
    const persisted = makePost({update_at: 120, message: 'authoritative copy'});
    assert.equal(state.messageForPost(post, makeSnapshot({updated_at: 110}), persisted, 200), 'authoritative copy');
});

test('event store rejects older sequences and expires leases', () => {
    const store = new state.EventStore();
    assert.equal(store.publish(makeSnapshot({seq: 2, message: 'newer'}), 200), true);
    assert.equal(store.publish(makeSnapshot({seq: 1, message: 'older'}), 200), false);
    assert.equal(store.get('post-1', 200).message, 'newer');
    assert.equal(store.get('post-1', 500), null);
});

test('event store notifies subscribers on close and refreshes after reconnect', () => {
    const store = new state.EventStore();
    let updates = 0;
    let refreshes = 0;
    store.subscribe('post-1', () => updates++);
    store.registerRefresh(() => refreshes++);
    store.publish(makeSnapshot(), 200);
    const closed = makeSnapshot({seq: 2, closed: true, updated_at: 102});
    store.publish(closed, 200);
    assert.equal(store.publish(closed, 200), true);
    assert.equal(store.publish(makeSnapshot({seq: 3, updated_at: 103}), 200), false);
    store.refreshAll();
    assert.equal(updates, 2);
    assert.equal(refreshes, 1);
    assert.equal(store.get('post-1', 200).closed, true);
});

test('event store stays bounded and prunes expired posts during publish', () => {
    const store = new state.EventStore();
    for (let index = 0; index < 256; index++) {
        assert.equal(store.publish(makeSnapshot({
            post_id: `post-${index}`,
            seq: 1,
            expires_at: 500,
        }), 200), true);
    }
    let evictedUpdates = 0;
    store.subscribe('post-0', () => evictedUpdates++);
    assert.equal(store.publish(makeSnapshot({
        post_id: 'post-256',
        seq: 1,
        expires_at: 500,
    }), 200), true);
    assert.equal(store.get('post-0', 200), null);
    assert.equal(evictedUpdates, 1);
    assert.equal(store.get('post-256', 200).message, 'live response');

    assert.equal(store.publish(makeSnapshot({
        post_id: 'expired-post',
        seq: 1,
        expires_at: 250,
    }), 200), true);
    let expiredUpdates = 0;
    store.subscribe('expired-post', () => expiredUpdates++);
    assert.equal(store.publish(makeSnapshot({
        post_id: 'post-257',
        seq: 1,
        expires_at: 500,
    }), 251), true);
    assert.equal(store.get('expired-post', 251), null);
    assert.equal(expiredUpdates, 1);
});

test('post generation metadata is mandatory before preview is rendered', () => {
    const post = makePost({
        props: {
            openclaw_mattermost: {version: 1, kind: 'turn_result', channelId: 'channel-1'},
        },
    });
    assert.equal(state.snapshotForPost(post, makeSnapshot(), 200), null);
});

test('plugin refreshes active snapshots after Mattermost reconnects', () => {
    let plugin;
    const browserWindow = {
        OpenClawStreamState: state,
        registerPlugin: (id, instance) => {
            assert.equal(id, 'openclaw-stream');
            plugin = instance;
        },
    };
    const pluginSource = fs.readFileSync(path.join(__dirname, 'plugin.js'), 'utf8');
    const pluginSandbox = {window: browserWindow};
    vm.createContext(pluginSandbox);
    vm.runInContext(pluginSource, pluginSandbox);

    let reconnectHandler;
    plugin.initialize({
        registerPostTypeComponent: () => {},
        registerWebSocketEventHandler: () => {},
        registerReconnectHandler: (handler) => {
            reconnectHandler = handler;
        },
    }, {getState: () => ({})});

    assert.equal(typeof reconnectHandler, 'function');
    assert.doesNotThrow(() => reconnectHandler());
});
