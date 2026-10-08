import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../main/relay/index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function routePhoneChat(msg) {');
const end = source.indexOf('// IPC', start);
const route = source.slice(start, source.lastIndexOf('// ---------------------------------------------------------------------------', end));
let creates = [], dispatches = [], destroys = 0, probes = 0;
const context = vm.createContext({
  phoneWindowId: 'old', phoneWindowKey: 'conv:old-conversation', phonePromptKey: 'A',
  convWindows: new Map([['old-conversation', 'old']]),
  pruneConvWindows() {}, isWindowAlive(id) { return Boolean(id); }, rlog() {}, rwarn() {},
  async findReusablePhoneConversationId() { probes++; return ''; },
  ctx: {
    getWindowByRef() { return { destroy() { destroys++; } }; },
    listWindows() { return []; },
    dispatchWindowEvent(event) { dispatches.push(event); return { ok: true }; },
    async openWindow(type, params) { creates.push(params); return { ok: true, id: 'new' }; }
  }
});
vm.runInContext(route + '\nthis.routePhoneChat = routePhoneChat;', context);
await context.routePhoneChat({role:'user', text:'new turn', from:'phone', options:{promptKey:'B'}, __relayNewConversation:true});
assert.equal(destroys, 1);
assert.equal(probes, 0, 'explicit new session must skip historical reuse');
assert.equal(dispatches.length, 0);
assert.equal(creates.length, 1);
assert.equal(creates[0].code, 'B');
assert.equal(creates[0].payload, 'new turn');
assert.equal(context.convWindows.has('old-conversation'), false);
context.phoneWindowId = 'bound'; context.phoneWindowKey = 'conv:C'; context.convWindows.set('C','bound');
await context.routePhoneChat({role:'user', text:'bound turn', from:'phone', conversationId:'C', options:{promptKey:'B',model:'p|m'}, __relayNewConversation:true});
assert.equal(creates.length, 1, 'specified conversation wins over new flag');
assert.equal(dispatches.length, 1);
assert.equal(dispatches[0].target, 'bound');
assert.equal(dispatches[0].payload.__relayOptions.promptKey, undefined);
assert.equal(dispatches[0].payload.__relayOptions.model, 'p|m');
console.log('PASS relay new conversation and bound conversation routing');
