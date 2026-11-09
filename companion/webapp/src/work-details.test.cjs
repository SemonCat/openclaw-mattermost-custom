const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {JSDOM} = require('jsdom');
const React = require('react');
const {createRoot} = require('react-dom/client');
const {act} = React;

// Exercise real React DOM reconciliation, rather than a tree that only mirrors
// the JSX. Each root represents an independent reader of the same shared post.
test('reader toggles survive progress edits and terminal card updates; finals leave the disclosure', async () => {
    const dom = new JSDOM('<main><div id="a"></div><div id="b"></div></main>', {runScripts: 'outside-only'});
    const previousWindow = global.window;
    const previousDocument = global.document;
    global.window = dom.window;
    global.document = dom.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    dom.window.eval(fs.readFileSync(path.join(__dirname, 'task-progress.js'), 'utf8'));
    const {renderWork, renderCard} = dom.window.OpenClawTaskProgress;
    const roots = ['a', 'b'].map((id) => createRoot(dom.window.document.getElementById(id)));
    const source = 'Published commentary\nTool: checking the source';
    const post = {
        id: 'draft', channel_id: 'channel', message: source,
        props: {
            openclaw_mattermost: {version: 1, kind: 'turn_result', channelId: 'channel'},
            openclaw_work_details: {version: 1, source_message: source},
        },
    };
    const markdown = (text) => React.createElement('p', null, text);
    const draw = async (value) => act(async () => {
        roots.forEach((root) => root.render(renderWork(React, value, value.message, markdown)));
    });
    try {
        await draw(post);
        const [first, second] = [...dom.window.document.querySelectorAll('details')];
        assert.equal(first.open, false);
        assert.equal(second.open, false);
        assert.equal(first.querySelector('summary').textContent, 'Work details');
        first.open = true;
        const updated = {...post, message: source + '\nCheck passed',
            props: {...post.props, openclaw_work_details: {version: 1, source_message: source + '\nCheck passed'}}};
        const frozenShared = JSON.stringify(updated);
        await draw(updated);
        assert.equal(dom.window.document.querySelector('#a details'), first, 'preserve the same DOM disclosure');
        assert.equal(first.open, true);
        assert.equal(second.open, false, 'another reader stays closed');
        first.open = false;
        await draw(updated);
        assert.equal(first.open, false, 'updates also preserve a reader who closed it');
        assert.equal(JSON.stringify(updated), frozenShared, 'toggles never change shared post props');

        const final = {...updated, props: {openclaw_mattermost: updated.props.openclaw_mattermost}};
        await draw(final);
        assert.equal(dom.window.document.querySelectorAll('details').length, 0);
        assert.match(dom.window.document.getElementById('a').textContent, /Check passed/);

        const taskSource = '#### Task progress · In progress\n\n- [ ] Check';
        const card = {...post, id: 'card', message: taskSource, props: {
            openclaw_mattermost: {version: 1, kind: 'task_progress', channelId: 'channel'},
            openclaw_task_progress: {version: 1, source_message: taskSource, status: 'in_progress',
                steps: [{step: 'Check', status: 'in_progress'}],
                work_sessions: [{label: 'Reviewer', status: 'running', progress: 'Reviewing public summary'}],
                hidden_work_sessions: 0},
        }};
        await act(async () => roots[0].render(renderCard(React, card, markdown)));
        const disclosure = dom.window.document.querySelector('#a details');
        assert.equal(disclosure.open, false);
        assert.match(disclosure.querySelector('summary').textContent, /Working.*0 of 1/);
        disclosure.open = true;
        const recovered = {...card, message: taskSource.replace('In progress', 'Failed')};
        await act(async () => roots[0].render(renderCard(React, recovered, markdown)));
        assert.equal(dom.window.document.querySelector('#a details'), disclosure);
        assert.equal(disclosure.open, true);
        assert.match(disclosure.querySelector('summary').textContent, /Failed.*Task failed/);
        assert.doesNotMatch(disclosure.querySelector('summary').textContent, /Working/);
        assert.equal(disclosure.querySelectorAll('.oc-task-icon--spin').length, 0);
        assert.match(disclosure.textContent, /Reviewing public summary/);
    } finally {
        await act(async () => roots.forEach((root) => root.unmount()));
        dom.window.close();
        global.window = previousWindow;
        global.document = previousDocument;
        delete global.IS_REACT_ACT_ENVIRONMENT;
    }
});
