import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';

// Run from this repository; upstream source archives and probe dependencies live outside it.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const evidence = process.argv[2] && resolve(process.argv[2]);
if (!evidence) throw new Error('Usage: node docs/probes/mattermost-streaming-probe.mjs <research-source-root>');
const work = join(evidence, 'probe-runtime');
const mobile = join(evidence, 'mattermost-mobile-v2.45.0/app/products/agents');
const web = join(evidence, 'mattermost-plugin-agents-v2.10.0/webapp/src/websocket.ts');
const storeSource = join(mobile, 'store/streaming_store.ts');
await build({
  entryPoints: [storeSource], bundle: true, platform: 'node', format: 'esm',
  outfile: join(work, 'official-mobile-store.mjs'), nodePaths: [join(work, 'node_modules')],
  plugins: [{name: 'official-source-aliases', setup(b) {
    b.onResolve({filter: /^@agents\/(constants|types)$/}, args => ({path: join(mobile, args.path.endsWith('constants') ? 'constants.ts' : 'types/index.ts')}));
    b.onResolve({filter: /^@utils\/log$/}, () => ({path: 'logs', namespace: 'probe'}));
    b.onLoad({filter: /.*/, namespace: 'probe'}, () => ({contents: 'export const logDebug = (...args) => {}; export const logWarning = (...args) => {throw new Error(JSON.stringify(args));};'}));
  }}],
});
await build({entryPoints: [web], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'official-web-listener.mjs')});
const {default: store} = await import(pathToFileURL(join(work, 'official-mobile-store.mjs')));
const {default: PostEventListener} = await import(pathToFileURL(join(work, 'official-web-listener.mjs')));
const {createLivePreviewLifecycle, createPreviewMessageReceipt} = await import(pathToFileURL(join(repo, 'node_modules/openclaw/dist/plugin-sdk/channel-outbound.js')));
const checks = [];
const check = (name, fn) => {fn(); checks.push(name);};
const server = 'https://local.invalid';
const postId = 'result_identity_1';
const listener = new PostEventListener();
const received = [];
listener.registerPostUpdateListener(postId, 'probe', e => received.push(e.data));
const sequence = [];
let durable = {id: postId, message: ''};
let closed = false;
const send = data => {
  const event = {event: 'custom_mattermost-ai_postupdate', data: {post_id: postId, ...data}};
  sequence.push(event.data);
  listener.handlePostUpdateWebsockets(event);
  store.handleWebSocketMessage(server, event.data);
};
// Synthetic invocation of the published channel callback contract. No model or Gateway runs here.
const replyOptions = {
  onPartialReply: ({text}) => {
    if (closed || typeof text !== 'string') return false;
    send({next: text});
    return true;
  },
};
const lifecycle = createLivePreviewLifecycle({
  draft: {
    id: () => postId,
    flush: async () => {},
    seal: async () => {closed = true;},
    discardPending: async () => {closed = true;},
    clear: async () => {throw new Error('Final post must not be deleted');},
  },
});
send({control: 'start'});
await replyOptions.onPartialReply({text: '逐'});
await replyOptions.onPartialReply({text: '逐字 🐾'});
check('published SDK: ephemeral progress is not durable final delivery', () => assert.equal(lifecycle.finalDelivered, false));
check('official mobile: cumulative next replaces instead of appending', () => assert.equal(store.getStreamingState(server, postId).message, '逐字 🐾'));
await replyOptions.onPartialReply({text: '更正後內容'});
check('official mobile: full snapshot supports replacement', () => assert.equal(store.getStreamingState(server, postId).message, '更正後內容'));
const outcome = await lifecycle.deliver({
  kind: 'final', payload: {text: '最終內容'},
  adapter: {
    buildFinalEdit: payload => ({message: payload.text}),
    editFinal: async (id, edit) => {
      assert.equal(id, postId);
      durable = {id, message: edit.message};
      sequence.push({persisted: id, message: edit.message});
      const receipt = createPreviewMessageReceipt({id});
      return {visibleReplySent: true, content: edit.message, receipt, messageIds: receipt.platformMessageIds};
    },
  },
  deliverNormally: async () => {throw new Error('Unexpected duplicate final send');},
});
send({control: 'end'});
check('published SDK: same post identity finalizes without duplicate create', () => {
  assert.equal(outcome.kind, 'preview-finalized');
  assert.equal(lifecycle.finalSucceeded, true);
  assert.equal(durable.id, postId);
  assert.equal(durable.message, '最終內容');
  assert.equal(sequence.at(-2).persisted, postId);
  assert.equal(sequence.at(-1).control, 'end');
});
await replyOptions.onPartialReply({text: 'late producer tail'});
check('bridge lifecycle fence: sealed producer cannot restart ended stream', () => assert.equal(store.isStreaming(server, postId), false));
check('official web listener: same identity receives lifecycle and snapshots', () => {
  assert.deepEqual(received.map(x => x.control || x.next), ['start', '逐', '逐字 🐾', '更正後內容', 'end']);
});
store.removePost(server, postId);
check('official mobile: persisted readback can retire ephemeral state', () => assert.equal(store.getStreamingState(server, postId), undefined));

const stopId = 'cancel_identity';
store.handleWebSocketMessage(server, {post_id: stopId, control: 'start'});
store.handleWebSocketMessage(server, {post_id: stopId, next: 'partial'});
store.markStopped(server, stopId);
store.handleWebSocketMessage(server, {post_id: stopId, next: 'late text'});
store.handleWebSocketMessage(server, {post_id: stopId, control: 'reasoning_summary', reasoning: 'late reasoning'});
check('official mobile: local Stop suppresses late text and reasoning', () => {
  const s = store.getStreamingState(server, stopId);
  assert.equal(s.message, 'partial'); assert.equal(s.reasoning, ''); assert.equal(s.generating, false);
});
store.handleWebSocketMessage(server, {post_id: stopId, control: 'cancel'});
store.handleWebSocketMessage(server, {post_id: stopId, next: 'unfenced tail'});
check('official mobile: cancel alone is not a producer fence', () => assert.equal(store.getStreamingState(server, stopId).generating, true));

store.handleWebSocketMessage(server, {post_id: 'reconnect', next: 'full snapshot after missed start'});
store.handleWebSocketMessage('https://second.invalid', {post_id: 'reconnect', next: 'other server'});
check('official mobile: missed start recovers from cumulative next and isolates servers', () => {
  assert.equal(store.getStreamingState(server, 'reconnect').message, 'full snapshot after missed start');
  assert.equal(store.getStreamingState('https://second.invalid', 'reconnect').message, 'other server');
});
const late = [];
listener.registerPostUpdateListener(postId, 'late', e => late.push(e.data));
check('official web listener: text is not a replayable snapshot cache', () => assert.equal(late.length, 0));

const failed = createLivePreviewLifecycle({draft: {id: () => 'failed', flush: async () => {}, seal: async () => {}, clear: async () => {}}});
await assert.rejects(failed.deliver({
  kind: 'final', payload: {text: 'not persisted'},
  adapter: {buildFinalEdit: p => p, editFinal: async () => {throw new Error('persistence failed');}},
  deliverNormally: async () => {throw new Error('fallback also failed');},
}), /fallback also failed/);
check('published SDK: rejected persistence is not successful final delivery', () => {
  assert.equal(failed.finalSucceeded, false); assert.equal(failed.finalFailed, true);
});
const files = [storeSource, web, join(mobile, 'constants.ts'), join(mobile, 'types/index.ts'), join(repo, 'node_modules/openclaw/dist/plugin-sdk/channel-outbound.js')];
const sources = await Promise.all(files.map(async path => ({source: path.startsWith(repo) ? path.slice(repo.length) : path.slice(evidence.length + 1), sha256: createHash('sha256').update(await readFile(path)).digest('hex')})));
const receipt = {executedAt: new Date().toISOString(), node: process.version, openclaw: JSON.parse(await readFile(join(repo, 'node_modules/openclaw/package.json'))).version, casesPassed: checks.length, checks, sources, sequence, limits: ['Callbacks are synthetically invoked; no live model/Gateway.', 'Official mobile state and web event listener execute, not actual UI components.', 'Mock persistence and event fanout; no Mattermost server, authentication, transport, or plugin installation tested.', 'No credentials or live services used.']};
await writeFile(join(evidence, 'websocket-probe-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({casesPassed: checks.length, checks, receipt: join(evidence, 'websocket-probe-receipt.json')}, null, 2));
