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

const reset = () => { creates = []; dispatches = []; destroys = 0; probes = 0; };

// ---- 场景 1：手机自建窗口（key='phone'）换助手 → 关掉旧窗口，开新会话 ----
// 这是「换助手」的本来语义：手机不要那个临时会话了，旧窗口该关。
reset();
context.phoneWindowId = 'old';
context.phoneWindowKey = 'phone';
context.convWindows = new Map();
await context.routePhoneChat({role:'user', text:'new turn', from:'phone', options:{promptKey:'B'}, __relayNewConversation:true});
assert.equal(destroys, 1, 'phone-created window must be closed on forced new conversation');
assert.equal(probes, 0, 'explicit new session must skip historical reuse');
assert.equal(dispatches.length, 0);
assert.equal(creates.length, 1);
assert.equal(creates[0].code, 'B');
assert.equal(creates[0].payload, 'new turn');

// ---- 场景 2：窗口已绑定到**某个电脑端会话**时换助手 → 不能销毁它 ----
// ⚠️ 多会话并行的核心规则：那个会话可能正在跑长任务，毁掉窗口等于掐断它。
// 手机放弃的只是「自己跟这个会话的绑定」，不是「要求电脑端停掉这个会话」。
// 只清槽位；窗口本身和 convWindows 里的登记都保留（窗口闲置后由
// reclaimConversationWindows 回收）。
reset();
context.phoneWindowId = 'boundA';
context.phoneWindowKey = 'conv:A';
context.convWindows = new Map([['A', 'boundA']]);
await context.routePhoneChat({role:'user', text:'switch assistant', from:'phone', options:{promptKey:'B'}, __relayNewConversation:true});
assert.equal(destroys, 0, 'must NOT destroy a window bound to a real conversation');
assert.equal(context.convWindows.get('A'), 'boundA', 'its registration must survive');
assert.equal(dispatches.length, 0);
assert.equal(creates.length, 1, 'still opens a fresh conversation for the new assistant');
assert.equal(creates[0].code, 'B');
assert.equal(context.phoneWindowId, 'new');

// ---- 场景 3：手机指定了会话 → 忽略「开新会话」，投递到那个会话 ----
// （原行为不变：target 必须是那个会话的窗口，且不能把 promptKey 带进去）
reset();
context.phoneWindowId = 'bound';
context.phoneWindowKey = 'conv:C';
context.convWindows = new Map([['C', 'bound']]);
await context.routePhoneChat({role:'user', text:'bound turn', from:'phone', conversationId:'C', options:{promptKey:'B',model:'p|m'}, __relayNewConversation:true});
assert.equal(creates.length, 0, 'specified conversation wins over new flag');
assert.equal(destroys, 0);
assert.equal(dispatches.length, 1);
assert.equal(dispatches[0].target, 'bound');
assert.equal(dispatches[0].payload.__relayOptions.promptKey, undefined);
assert.equal(dispatches[0].payload.__relayOptions.model, 'p|m');
console.log('PASS relay new conversation and bound conversation routing');
