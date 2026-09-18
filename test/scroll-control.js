'use strict';
/**
 * scroll-control.js — 协同滚动的多层面控制单测（worklist 144）：vm 沙箱直接驱动真实 syncscroll.js，
 * 不依赖 app.js/PDF，聚焦层2/3/4 的机制：
 *   层2 手势模型：被驱动方 echo scroll 不反客为主（A↔B 震荡杜绝）；
 *   层3 弹性钳制：错映射大跳被截断到 ≤ max(MIN, |源Δ|×RATIO) 行，小滚不跳页；
 *   层3 方向单调：源下滚时目标回退不超过 TOL 行；
 *   层4 边界滚轮：源贴边后继续滚用虚拟位置持续驱动目标（死锁解除）。
 * 运行：node test/scroll-control.js
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

function mkEl() {
  var el = {
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, style: {}, _listeners: {},
    addEventListener: function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener: function () {},
    dispatch: function (t, ev) { (this._listeners[t] || []).slice().forEach(function (f) { f(ev || {}); }); }
  };
  return el;
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name + (extra ? '（' + extra + '）' : '')); }
  else { failed++; console.log('FAIL  ' + name + (extra ? '：' + extra : '')); }
}

var sandbox = {
  console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/syncscroll.js'), 'utf8'), sandbox, { filename: 'syncscroll.js' });
var Sync = sandbox.SyncScroll;

var H = 20;                                   // 测试行高
function lineAdapter(side) {
  return {
    side: side, space: 'text',
    lineAt: function (px) { return Math.floor(px / H) + 1; },
    offsetOf: function (line) { var l = Math.max(1, Math.floor(line)); return Math.max(0, (l - 1) * H + (line - l) * H); },
    lineH: function () { return H; }
  };
}
function rebindPair(mL, mR, translator) {
  Sync.setAdapter(mL, lineAdapter('L'));
  Sync.setAdapter(mR, lineAdapter('R'));
  Sync.setTranslator(translator);
  Sync.rebind([mL, mR]);
}
function drive(el, scrollTop) { el.scrollTop = scrollTop; el.dispatch('scroll'); return wait(40); }
function topLine(scrollTop) { return Math.round(scrollTop / H) + 1; }

(async function main() {
  // ---- 层2：手势模型 —— 被驱动方 echo 不反驱 ----
  {
    var mL = mkEl(), mR = mkEl();
    mL.scrollHeight = 5000; mL.clientHeight = 100;
    mR.scrollHeight = 5000; mR.clientHeight = 100;
    rebindPair(mL, mR, function (s, o, e) { return e; });
    await drive(mL, 200);                       // 左驱动到行 11
    var rPos = mR.scrollTop;
    check('层2：源驱动后目标跟随', Math.abs(mR.scrollTop - 200) <= 1, '右 ' + mR.scrollTop.toFixed(1));
    await drive(mR, rPos);                      // 模拟浏览器回写产生的 echo scroll
    check('层2：被驱动方 echo scroll 不反客为主', Math.abs(mL.scrollTop - 200) <= 1,
      '左仍 ' + mL.scrollTop + '（若变则震荡）');
  }

  // ---- 层3：弹性钳制 —— 错映射大跳被截断、小滚不跳页 ----
  {
    var mL = mkEl(), mR = mkEl();
    mL.scrollHeight = 5000; mL.clientHeight = 100;
    mR.scrollHeight = 5000; mR.clientHeight = 100;
    rebindPair(mL, mR, function (s, o, e) { return e + 30; });   // 错映射：目标比源大跳 30 行
    await drive(mL, 180);                       // 源到行 10（一步 Δ9 行）
    var bad = mR.scrollTop;
    check('层3：错映射 30 行大跳被截断到 ≤1.25×源Δ', Math.abs(bad - 225) <= 1,
      '目标行 ' + topLine(bad) + '（未钳制会到行 40=' + ((40 - 1) * H) + 'px）');
    await drive(mL, 190);                       // 源继续到行 10.5（Δ0.5 行）
    var small = mR.scrollTop;
    check('层3：小滚不跳页（目标仅小幅跟进）', small > bad && small < bad + 40 && small < 300,
      '目标 ' + bad.toFixed(0) + '→' + small.toFixed(0) + 'px');
  }

  // ---- 层3：方向单调 —— 源下滚时目标回退不超过 TOL 行 ----
  {
    var mL = mkEl(), mR = mkEl();
    mL.scrollHeight = 5000; mL.clientHeight = 100;
    mR.scrollHeight = 5000; mR.clientHeight = 100;
    // 回摆映射：行≥10 时目标应映射回 7 行（坏映射会把目标往回拽），源却持续下滚
    rebindPair(mL, mR, function (s, o, e) { return e >= 10 ? e - 3 : e + 30; });
    await drive(mL, 160);                       // 源行 9 → 目标行 ~11
    var eBefore = mR.scrollTop / H + 1;
    await drive(mL, 180);                       // 源行 10（下滚），坏映射想把目标拽到行 7
    var eAfter = mR.scrollTop / H + 1;
    check('层3：方向单调（源下滚目标仅小回退）', eBefore - eAfter <= 0.21 && eAfter > 8,
      '目标连续行位 ' + eBefore.toFixed(2) + '→' + eAfter.toFixed(2) + '（未钳制会回到 7）');
  }

  // ---- 层4：边界滚轮 —— 源贴边继续滚，目标持续推进到其 max ----
  {
    var mL = mkEl(), mR = mkEl();
    mL.scrollHeight = 1000; mL.clientHeight = 100;   // 左 max = 900
    mR.scrollHeight = 5000; mR.clientHeight = 100;   // 右 max = 4900
    rebindPair(mL, mR, function (s, o, e) { return e; });
    await drive(mL, 900);                        // 左滚到底
    var before = mR.scrollTop;
    check('层4：左到底后目标同步到底对应位置', Math.abs(mR.scrollTop - 900) <= 1, '右 ' + mR.scrollTop.toFixed(0));
    for (var i = 0; i < 3; i++) {                // 左贴边继续滚 3 次（虚拟位置累积）
      mL.dispatch('wheel', { deltaY: 120, deltaMode: 0 });
      await wait(40);
    }
    check('层4：源保持贴边不动', Math.abs(mL.scrollTop - 900) <= 1, '左 ' + mL.scrollTop);
    check('层4：边界滚轮驱动目标推进（死锁解除）', mR.scrollTop > before + 150,
      '右 ' + before.toFixed(0) + '→' + mR.scrollTop.toFixed(0) + 'px');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.log('FAIL  ' + (e && e.message));
  process.exit(1);
});
