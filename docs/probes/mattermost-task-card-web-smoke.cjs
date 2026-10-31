// Run only against a disposable loopback Mattermost fixture, never production.
// PLAYWRIGHT_MODULE=/path/to/playwright MATTERMOST_TEST_URL=http://localhost:8065 \
// node this-file.cjs /private/fixture-state.json /private/browser-receipt.json
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const base = process.env.MATTERMOST_TEST_URL || 'http://localhost:18066';
    assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Loopback fixture required');
    const output = path.dirname(process.argv[3]);
    const checks = [];
    const errors = [];
    const api = async (route, body, token = state.bot_token, method) => {
        const response = await fetch(base + route, {
            method: method || (body === undefined ? 'GET' : 'POST'),
            headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
            ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
        assert(response.ok, `${route}: HTTP ${response.status}`);
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    };
    const steps = ['Review PR diff', 'Request remote dev Mac',
        'Build PR on iPhone 17 Pro simulator', 'Test Order Details', 'Test Discount Details'];
    const payload = (completed, status = 'in_progress') => {
        const message = `#### Task progress · ${status === 'completed' ? 'Completed' : 'In progress'}\nReview PR #2081245\n\n` +
            steps.map((step, i) => i < completed ? `- [x] ${step}`
                : i === completed ? `- [ ] **${step}**` : `- [ ] ${step}`).join('\n');
        return {
            message,
            props: {
                openclaw_mattermost: {version: 1, kind: 'task_progress',
                    channelId: state.channel_id, accountId: 'default', agentId: 'main'},
                openclaw_task_progress: {
                    version: 1, source_message: message, title: 'Review PR #2081245', status,
                    steps: steps.map((step, i) => ({step, status: i < completed ? 'completed'
                        : i === completed ? 'in_progress' : 'pending'})),
                    work_sessions: [], hidden_work_sessions: 0,
                },
            },
        };
    };
    const browser = await chromium.launch({headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage']});
    let page;
    try {
        await api(`/api/v4/users/${state.reader_id}/preferences/delete`, [{
            user_id: state.reader_id, category: 'theme', name: '', value: '',
        }], state.reader_token);
        const context = await browser.newContext({viewport: {width: 1365, height: 1000}});
        await context.addInitScript(() => localStorage.setItem('__landingPageSeen__', 'true'));
        page = await context.newPage();
        let connected = false;
        page.on('websocket', (socket) => socket.on('framereceived', ({payload}) => {
            if (typeof payload === 'string' && JSON.parse(payload).event === 'hello') connected = true;
        }));
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${base}/login`);
        await page.getByRole('textbox', {name: 'Email or Username'}).fill('probereader');
        await page.locator('input[type=password]').fill(state.reader_password);
        await page.getByRole('button', {name: 'Log in', exact: true}).click();
        await page.waitForURL('**/channels/**');
        connected = false;
        await page.goto(`${base}/task-ui-probe/channels/town-square`);
        await page.waitForFunction(() => !!window.OpenClawTaskProgress);
        const deadline = Date.now() + 10_000;
        while (!connected) {
            assert(Date.now() < deadline, 'Authenticated Mattermost WebSocket did not connect');
            await page.waitForTimeout(20);
        }
        const dismiss = page.getByText(/No thanks/);
        try {
            await dismiss.waitFor({state: 'visible', timeout: 3000});
            await dismiss.click();
        } catch (error) {
            if (error.name !== 'TimeoutError' || await dismiss.isVisible()) throw error;
        }
        const post = await api('/api/v4/posts', {channel_id: state.channel_id, ...payload(2)});
        assert.equal(post.type, 'custom_openclaw_task');
        const card = page.locator(`#post_${post.id} .oc-task-card`);
        await card.getByRole('heading', {name: 'Review PR #2081245'}).waitFor();
        await card.getByText('2 of 5 steps completed', {exact: true}).waitFor();
        assert.equal(await card.locator('.oc-task-icon--completed').count(), 2);
        assert.equal(await card.locator('.oc-task-icon--spin').count(), 1);
        await card.locator('time').waitFor();
        checks.push('allowed bot standard REST create receives rich task presentation in real Mattermost');
        await card.screenshot({path: path.join(output, 'task-card-working.png')});

        await api(`/api/v4/posts/${post.id}/patch`, payload(5, 'completed'), state.bot_token, 'PUT');
        await card.getByText('All steps completed', {exact: true}).waitFor();
        assert.equal(await card.locator('.oc-task-icon--completed').count(), 5);
        assert.equal(await card.locator('.oc-task-icon--spin').count(), 0);
        await card.screenshot({path: path.join(output, 'task-card-completed.png')});
        checks.push('same card updates to five blue completion checks and a truthful terminal state');
        await page.reload();
        await card.getByText('All steps completed', {exact: true}).waitFor();
        checks.push('reload restores the terminal card from durable props');

        await page.setViewportSize({width: 390, height: 844});
        await card.getByText('All steps completed', {exact: true}).waitFor();
        const bounds = await card.boundingBox();
        assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'Narrow card overflows viewport');
        await page.screenshot({path: path.join(output, 'task-card-narrow-page.png'), animations: 'disabled'});
        await card.screenshot({path: path.join(output, 'task-card-narrow.png'), animations: 'disabled'});
        checks.push('390px narrow web layout wraps checklist without horizontal overflow');
        await page.setViewportSize({width: 1365, height: 1000});
        await page.emulateMedia({reducedMotion: 'reduce'});
        await api(`/api/v4/posts/${post.id}/patch`, payload(2), state.bot_token, 'PUT');
        await card.getByText('2 of 5 steps completed', {exact: true}).waitFor();
        const animation = await card.locator('.oc-task-icon--spin').evaluate((el) =>
            getComputedStyle(el).animationName);
        assert.equal(animation, 'none');
        checks.push('reduced motion disables animation while keeping current-step status');
        const recovery = payload(2).message.replace('In progress', 'Failed');
        await api(`/api/v4/posts/${post.id}/patch`, {message: recovery}, state.bot_token, 'PUT');
        await card.getByText('Task failed', {exact: true}).waitFor();
        assert.equal(await card.locator('.oc-task-icon--spin').count(), 0);
        checks.push('message-only restart recovery terminal edit overrides stale active props');

        const dark = {type: 'Mattermost Dark', sidebarBg: '#1e2129', sidebarText: '#ffffff',
            sidebarUnreadText: '#ffffff', sidebarTextHoverBg: '#33373f', sidebarTextActiveBorder: '#5d89ea',
            sidebarTextActiveColor: '#ffffff', sidebarHeaderBg: '#1b1d22', sidebarHeaderTextColor: '#ffffff',
            onlineIndicator: '#3db887', awayIndicator: '#ffbc1f', dndIndicator: '#f74343',
            mentionBg: '#ffffff', mentionColor: '#1e2129', centerChannelBg: '#1b1d22',
            centerChannelColor: '#dddddd', newMessageSeparator: '#5d89ea', linkColor: '#5d89ea',
            buttonBg: '#5d89ea', buttonColor: '#ffffff', errorTextColor: '#f74343',
            mentionHighlightBg: '#984063', mentionHighlightLink: '#a4c7ff', codeTheme: 'monokai'};
        await api(`/api/v4/users/${state.reader_id}/preferences`, [{
            user_id: state.reader_id, category: 'theme', name: '', value: JSON.stringify(dark),
        }], state.reader_token, 'PUT');
        await api(`/api/v4/posts/${post.id}/patch`, payload(5, 'completed'), state.bot_token, 'PUT');
        await page.reload();
        await card.getByText('All steps completed', {exact: true}).waitFor();
        const darkStyle = await card.evaluate((el) => ({
            color: getComputedStyle(el).color,
            background: getComputedStyle(el).getPropertyValue('--center-channel-bg').trim(),
        }));
        assert(darkStyle.background && !['#fff', '#ffffff'].includes(darkStyle.background));
        assert.notEqual(darkStyle.color, 'rgb(63, 67, 80)');
        await card.screenshot({path: path.join(output, 'task-card-dark.png')});
        checks.push('task card uses the actual Mattermost dark theme');

        // Test the same older-post handoff used when commentary precedes a plan.
        const older = await api('/api/v4/posts', {channel_id: state.channel_id, message: 'Commentary first'});
        const successor = await api('/api/v4/posts', {channel_id: state.channel_id, message: 'Preserved result'});
        const handoff = await api(`/api/v4/posts/${older.id}/patch`, payload(5, 'completed'), state.bot_token, 'PUT');
        assert.equal(handoff.type, 'custom_openclaw_task');
        assert(handoff.create_at < successor.create_at);
        await page.locator(`#post_${older.id} .oc-task-card`).getByText('All steps completed').waitFor();
        assert.equal((await api(`/api/v4/posts/${successor.id}`)).message, 'Preserved result');
        checks.push('late-plan patch promotes older standard post to rich card while successor keeps result');

        await api(`/api/v4/posts/${post.id}/patch`, {message: 'Authoritative external edit'}, state.bot_token, 'PUT');
        await page.locator(`#post_${post.id}`).getByText('Authoritative external edit', {exact: true}).waitFor();
        assert.equal(await page.locator(`#post_${post.id} .oc-task-card`).count(), 0);
        checks.push('changed durable content falls back to native Markdown instead of stale card data');
        await api('/api/v4/plugins/openclaw-stream/disable', {}, state.admin_token);
        await page.reload();
        await page.locator(`#post_${older.id}`).getByText('Review PR #2081245', {exact: true}).waitFor();
        assert.equal(await page.locator('.oc-task-card').count(), 0);
        checks.push('disabled companion leaves readable durable Markdown');
        await api('/api/v4/plugins/openclaw-stream/enable', {}, state.admin_token);
        assert.equal(errors.length, 0, JSON.stringify(errors));
        const receipt = {verified_at: new Date().toISOString(), server: 'Mattermost Team Edition 12.0.1',
            chromium: browser.version(), scope: 'Disposable fixture; synthetic publisher, real Mattermost web UI',
            post_id: post.id, checks, page_errors: errors};
        fs.writeFileSync(process.argv[3], JSON.stringify(receipt, null, 2) + '\n');
        console.log(JSON.stringify(receipt, null, 2));
    } catch (error) {
        if (page) {
            await page.screenshot({path: path.join(output, 'task-card-failure.png')});
            fs.writeFileSync(path.join(output, 'task-card-failure.json'), JSON.stringify({
                url: page.url(), body: await page.locator('body').innerText(), page_errors: errors,
            }, null, 2));
        }
        throw error;
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
