const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const toolText = 'Write note.md; Exec; Preparing executor activation';
const makePost = (message = toolText) => ({
    id: 'preview', channel_id: 'channel', root_id: 'thread', user_id: 'bot',
    type: 'custom_openclaw_stream', update_at: 100, message,
    props: {
        openclaw_mattermost: {version: 1, kind: 'turn_result', channelId: 'channel', threadId: 'thread'},
        openclaw_stream: {version: 1, generation: 'generation'},
    },
});
const text = (tree) => typeof tree === 'string' ? tree : (tree?.children || []).map(text).join('');

// Mount the actual registered component. Hooks retain state/dependencies across
// renders; fetch, the enclosing Mattermost store, and timers are local fixtures.
function fixture(post = makePost()) {
    let plugin;
    let reconnect;
    let component;
    let cursor = 0;
    let dirty = false;
    let tree;
    let response = {status: 200, body: post};
    const hooks = [];
    const effects = [];
    const calls = [];
    const actions = [];
    const posts = new Map([
        [post.id, post],
        ['card', {id: 'card', message: 'Task progress · Incomplete (2/3)'}],
        ['final', {id: 'final', message: 'Waiting for scheduled deployment.'}],
    ]);
    const React = {
        createElement: (tag, props, ...children) => typeof tag === 'function' ?
            tag(props) : {tag, props, children},
        useState(initial) {
            const index = cursor++;
            if (!hooks[index]) hooks[index] = {value: typeof initial === 'function' ? initial() : initial};
            return [hooks[index].value, (value) => {
                if (!Object.is(hooks[index].value, value)) {
                    hooks[index].value = value;
                    dirty = true;
                }
            }];
        },
        useEffect(callback, deps) {
            const index = cursor++;
            if (!hooks[index] || deps.some((dep, i) => !Object.is(dep, hooks[index].deps[i]))) {
                effects.push(() => {
                    hooks[index]?.cleanup?.();
                    hooks[index] = {deps, cleanup: callback()};
                });
            }
        },
    };
    const browser = {
        React, location: {origin: 'https://mattermost.example.invalid'},
        setTimeout: () => 1, clearTimeout: () => {},
        fetch: async (url, options) => {
            calls.push({url, options});
            if (url.includes('/plugins/')) return {ok: false, status: 404};
            if (typeof response === 'function') return response();
            if (response instanceof Error) throw response;
            return {ok: response.status === 200, status: response.status, json: async () => response.body};
        },
        registerPlugin: (_, instance) => { plugin = instance; },
    };
    const sandbox = {window: browser, Date, Map, Set, Number, Object, Array, Math};
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/stream-state.js'), 'utf8'), sandbox);
    browser.OpenClawStreamState = sandbox.OpenClawStreamState;
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'plugin.js'), 'utf8'), sandbox);
    plugin.initialize({
        registerPostTypeComponent: (type, render) => {
            if (type === 'custom_openclaw_stream') component = render;
        },
        registerWebSocketEventHandler: () => {},
        registerReconnectHandler: (handler) => { reconnect = handler; },
    }, {
        getState: () => ({entities: {posts: {posts: Object.fromEntries(posts)}}}),
        dispatch: (action) => {
            actions.push(action);
            // Mattermost's postRemoved action removes the row, not just its body.
            if (action.type === 'POST_REMOVED') posts.delete(action.data.id);
        },
    });
    const render = () => {
        cursor = 0;
        dirty = false;
        tree = posts.has(post.id) ? component({post}) : null;
        while (effects.length) effects.shift()();
    };
    render();
    return {
        calls, actions, posts,
        response: (next) => { response = next; },
        reconnect: () => reconnect(),
        renderedText: () => text(tree),
        unmount() {
            for (const hook of hooks) hook?.cleanup?.();
        },
        async settle() {
            for (let i = 0; i < 40; i++) {
                await Promise.resolve();
                if (dirty || !posts.has(post.id)) render();
            }
        },
    };
}

test('reconnect reconciles a missing persisted preview row while preserving card and final', async () => {
    const f = fixture();
    await f.settle();
    assert.match(f.renderedText(), /Write note.md/);
    f.response({status: 404});
    f.reconnect();
    await f.settle();
    assert.doesNotMatch(f.renderedText(), /Write note.md|Preparing executor activation/);
    assert.equal(f.posts.has('preview'), false, 'remove the obsolete row, not only its body');
    assert.deepEqual([...f.posts.keys()], ['card', 'final']);
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].type, 'POST_REMOVED');
    assert.equal(f.actions[0].data.id, 'preview');
    assert.deepEqual(f.calls.slice(-2).map((call) => new URL(call.url).pathname), [
        '/plugins/openclaw-stream/v1/posts/preview', '/api/v4/posts/preview',
    ]);
    assert.ok(f.calls.every((call) => call.options.credentials === 'same-origin' &&
        call.options.cache === 'no-store' && !call.options.method));
});

for (const status of [401, 403, 429, 500, 503, 'network']) {
    test(`preserves cached progress on persisted-post ${status} failure`, async () => {
        const f = fixture();
        await f.settle();
        f.response(status === 'network' ? new Error('offline') : {status});
        f.reconnect();
        await f.settle();
        assert.equal(f.renderedText(), toolText);
        assert.equal(f.posts.has('preview'), true);
        assert.equal(f.actions.length, 0);
    });
}

test('snapshot 404 retains a real persisted final and its row', async () => {
    const f = fixture();
    await f.settle();
    f.response({status: 200, body: makePost('Final answer.')});
    f.reconnect();
    await f.settle();
    assert.equal(f.renderedText(), 'Final answer.');
    assert.equal(f.posts.has('preview'), true);
    assert.equal(f.actions.length, 0);
});

test('a late 404 cannot evict a newer successful reconnect read', async () => {
    const f = fixture();
    await f.settle();
    let resolve;
    f.response(() => new Promise((done) => { resolve = done; }));
    f.reconnect();
    await f.settle();
    assert.equal(typeof resolve, 'function');
    f.response({status: 200, body: makePost('Final answer.')});
    f.reconnect();
    await f.settle();
    resolve({ok: false, status: 404});
    await f.settle();
    assert.equal(f.renderedText(), 'Final answer.');
    assert.equal(f.actions.length, 0);
});

for (const change of ['edit', 'card-handoff', 'unmount']) {
    test(`a late 404 cannot evict after ${change}`, async () => {
        const f = fixture();
        await f.settle();
        let resolve;
        f.response(() => new Promise((done) => { resolve = done; }));
        f.reconnect();
        await f.settle();
        if (change === 'unmount') f.unmount();
        else f.posts.set('preview', {
            ...makePost('New durable content.'), update_at: 200,
            ...(change === 'card-handoff' ? {type: 'custom_openclaw_task'} : {}),
        });
        resolve({ok: false, status: 404});
        await f.settle();
        assert.equal(f.posts.has('preview'), true);
        assert.equal(f.actions.length, 0);
    });
}
