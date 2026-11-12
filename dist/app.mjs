import { WORDS, WORD_BY_ID } from './words.mjs';
import {
  DAY, MINUTE, NEW_LIMIT, ROUND_SIZE, RETENTION, dayKey, freshState, getPlan,
  markExposure, nextContext, recordAttempt, stats, wordStatus,
} from './study.mjs';
import { icon } from './icons.mjs';
import { enableDepthEffects } from './motion.mjs';

const $ = selector => document.querySelector(selector);
const main = $('#main');
const modal = $('#modal');
const footer = $('#footer');
const STORAGE_KEY = 'wordloop-progress-v1';
const PAGE_SIZE = 18;
const pageNames = { today: '今日学习', words: '单词库', progress: '学习进度' };
const statusLabels = {
  unseen: '未学习', learning: '学习中', consolidating: '巩固中', mastered: '已掌握', applied: '会运用',
};
const taskLabels = {
  reading: ['看词回忆', 'book', 'blue'],
  listening: ['听音回忆', 'ear', 'green'],
  transfer: ['语境填词', 'pen', 'violet'],
};

let storageWorks = true;
let state = loadState();
let page = route();
let session = null;
let query = '';
let filter = 'all';
let bankPage = 0;
let planStamp = '';
let player = null;
let toastTimer;

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (stored?.version === 1 && stored.cards && stored.events && stored.hlr) return stored;
  } catch {
    storageWorks = false;
  }
  return freshState();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageWorks = true;
  } catch {
    storageWorks = false;
  }
  renderFooter();
}

function refreshState() {
  if (storageWorks) state = loadState();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function route() {
  const name = location.hash.slice(1);
  return Object.hasOwn(pageNames, name) ? name : 'today';
}

function currentNav() {
  return page === 'study' || page === 'done' ? 'today' : page;
}

function renderHeader() {
  $('#header').innerHTML = `<div class="top-inner">
    <a class="brand" href="#today" data-route="today" aria-label="词循首页">
      <span class="brand-mark">${icon('loop', 23)}</span>
      <span><span class="brand-name">词循</span><span class="brand-en">WORDLOOP</span></span>
    </a>
    <nav class="nav" aria-label="主导航">
      ${Object.entries(pageNames).map(([name, label]) =>
        `<a href="#${name}" data-route="${name}" ${currentNav() === name ? 'aria-current="page"' : ''}>${label}</a>`).join('')}
    </nav>
    <button class="button secondary top-action" data-action="reminder">${icon('bell', 16)}复习提醒</button>
  </div>`;
}

function renderFooter() {
  footer.innerHTML = `${icon('info', 14)}<span>${storageWorks
    ? '进度保存在当前浏览器'
    : '当前浏览器无法保存进度，保持网页打开可继续练习'}</span>`;
}

function go(next, updateUrl = true) {
  stopAudio();
  if (modal.open) modal.close();
  session = null;
  page = next;
  if (updateUrl && location.hash !== '#' + next) history.pushState(null, '', '#' + next);
  render();
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
}

function render() {
  renderHeader();
  renderFooter();
  if (page === 'today') renderToday();
  if (page === 'words') renderBank();
  if (page === 'progress') renderProgress();
  if (page === 'study') renderStudy();
  if (page === 'done') renderDone();
}

function localTime(at) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

function dueLabel(at, now = Date.now()) {
  if (at === null || at === undefined) return '待安排';
  const date = new Date(at);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const label = dayKey(at) === dayKey(now) ? '今天'
    : dayKey(at) === dayKey(tomorrow) ? '明天'
      : `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${label} ${localTime(at)}`;
}

function relativeLabel(at, now) {
  const minutes = Math.max(1, Math.ceil((at - now) / MINUTE));
  if (minutes < 60) return `${minutes} 分钟后`;
  if (minutes < 24 * 60) return `约 ${Math.ceil(minutes / 60)} 小时后`;
  return `约 ${Math.ceil((at - now) / DAY)} 天后`;
}

function metric(label, value, suffix, symbol, tone) {
  return `<div class="metric">
    <span class="icon-tile ${tone}">${icon(symbol, 21)}</span>
    <div><p class="metric-label">${label}</p><strong class="metric-value">${value}<small>${suffix}</small></strong></div>
  </div>`;
}

function renderToday() {
  const now = Date.now();
  const plan = getPlan(state, now);
  const counts = stats(state);
  const next = plan.upcoming[0];
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now);
  const cta = plan.round.length ? '开始练习' : '设置复习提醒';
  const duration = Math.max(1, Math.ceil(plan.round.length / 2));
  const queue = plan.round.slice(0, 3).map(task => {
    const [label, symbol, tone] = taskLabels[task.kind];
    const word = WORD_BY_ID[task.id];
    return `<li>
      <span class="icon-tile ${tone}">${icon(symbol, 17)}</span>
      <div><p class="queue-word" ${task.kind === 'reading' ? 'lang="en"' : ''}>${task.kind === 'reading' ? word.id : label}</p>
        <span class="queue-meta">${task.kind === 'reading' ? label : task.kind === 'listening' ? '播放发音，回忆词义' : '在新句子里拼写单词'}</span></div>
      <span class="tag ${task.isNew ? 'blue' : 'amber'}">${task.isNew ? '新词' : '到期'}</span>
    </li>`;
  }).join('');
  const scheduleTitle = plan.dueCount ? '现在可以复习' : next ? dueLabel(next.dueAt, now) : '练完后自动安排';
  const scheduleCaption = plan.dueCount ? `${plan.dueCount} 道题已到复习时间`
    : next ? relativeLabel(next.dueAt, now) : '完成第一张卡片即可看到时间';

  main.innerHTML = `<div class="page-context">
    <span class="context-name"><span class="context-dot"></span>今日学习</span>
    <span class="date-label">${icon('calendar', 15)}${dateLabel}</span>
  </div>
  <section class="hero" aria-labelledby="today-title" data-depth>
    <div class="hero-visual" aria-hidden="true"><img class="hero-art" src="./media/flashcards-night.webp" alt="" fetchpriority="high" width="1152" height="768"></div>
    <div class="hero-copy">
      <p class="hero-kicker">100 个难词 · 间隔复习</p>
      <h1 id="today-title">${plan.round.length ? '今天，把难词<span>记牢。</span>' : '这一轮练习完成了。'}</h1>
      <p class="hero-note">${plan.round.length ? '先复习到期词，再学新词。' : '到下次复习时间，再来回忆一遍。'}</p>
      <div class="hero-actions">
        <button class="button primary large" data-action="${plan.round.length ? 'begin' : 'reminder'}">${cta}${icon('arrow', 18)}</button>
        ${plan.round.length ? `<span class="hero-time">${icon('clock', 15)}约 ${duration} 分钟</span>` : ''}
      </div>
    </div>
  </section>
  <section class="metrics" aria-label="今日任务和掌握情况">
    ${metric('到期复习', plan.dueCount, '道', 'clock', 'amber')}
    ${metric('今日可学新词', plan.newCount, '个', 'layers', 'blue')}
    ${metric('已掌握单词', counts.mastered + counts.applied, '/ 100', 'shield', 'green')}
  </section>
  <div class="dashboard-grid">
    <section class="panel" aria-labelledby="queue-title">
      <div class="panel-header"><h2 id="queue-title">本轮练习</h2><span class="tag neutral">${plan.round.length} 张卡片</span></div>
      <p class="panel-note">${plan.round.length ? `每轮最多 ${ROUND_SIZE} 张卡片，到期优先` : '下次有到期词时会自动加入本轮'}</p>
      ${queue ? `<ul class="queue">${queue}</ul>` : '<p class="queue-empty">当前没有待练习的卡片。</p>'}
      ${plan.round.length > 3 ? `<div class="queue-more"><span>还有 ${plan.round.length - 3} 张</span><button class="button ghost small" data-action="begin">进入本轮${icon('arrow', 15)}</button></div>` : ''}
    </section>
    <section class="panel" aria-labelledby="schedule-title">
      <h2 id="schedule-title">下次复习</h2>
      <div class="schedule">
        <span class="icon-tile blue">${icon('calendar', 22)}</span>
        <div><p class="schedule-time">${scheduleTitle}</p><p class="schedule-caption">${scheduleCaption}</p></div>
      </div>
      <button class="button ghost small schedule-action" data-action="reminder">${icon('bell', 15)}加到日历${icon('arrow', 15)}</button>
    </section>
  </div>`;
  planStamp = todayStamp(plan, now);
}

function todayStamp(plan, now) {
  const next = plan.upcoming[0]?.dueAt;
  return [dayKey(now), plan.dueCount, plan.newCount, next, next && relativeLabel(next, now)].join('|');
}

function renderBank() {
  main.innerHTML = `<section class="page-title"><h1>单词库</h1>
    <p>100 个英语难词，每个词练一个目标词义。</p></section>
  <div class="bank-tools">
    <div class="search-wrap">${icon('search', 18)}
      <input id="word-search" type="search" autocomplete="off" aria-label="搜索单词或释义" placeholder="搜索单词或释义" value="${escapeHtml(query)}">
    </div>
    <div class="filter-list" role="group" aria-label="按学习状态筛选">
      ${[['all', '全部'], ['unseen', '未学习'], ['in-progress', '学习中'], ['mastered', '已掌握']]
        .map(([value, label]) => `<button class="button quiet small" data-filter="${value}" aria-pressed="${filter === value}">${label}</button>`).join('')}
    </div>
  </div>
  <div id="bank-grid" class="bank-grid"></div>
  <div id="bank-meta" class="bank-meta"></div>`;
  updateBank();
}

function updateBank() {
  const term = query.trim().toLowerCase();
  const matching = WORDS.filter(word => {
    const status = wordStatus(state.cards[word.id]);
    const matchesFilter = filter === 'all' || status === filter ||
      (filter === 'mastered' && status === 'applied') || (filter === 'in-progress' && ['learning', 'consolidating'].includes(status));
    return matchesFilter && (!term || [word.id, word.meaning, ...word.aliases].some(value => value.includes(term)));
  });
  const totalPages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  bankPage = Math.max(0, Math.min(bankPage, totalPages - 1));
  const start = bankPage * PAGE_SIZE;
  $('#bank-grid').innerHTML = matching.length ? matching.slice(start, start + PAGE_SIZE).map(word => {
    const status = wordStatus(state.cards[word.id]);
    return `<button class="word-tile" data-word="${word.id}">
      <span><strong lang="en">${word.id}</strong><small>/${word.ipa}/</small></span>
      <span class="tag ${status}">${statusLabels[status]}</span>
    </button>`;
  }).join('') : '<p class="empty-line">没有符合条件的单词。</p>';
  $('#bank-meta').innerHTML = `<span aria-live="polite">${matching.length} 个单词 · 第 ${bankPage + 1} / ${totalPages} 页</span>
    <div class="page-buttons">
      <button class="button secondary small" data-action="bank-prev" ${bankPage === 0 ? 'disabled' : ''}>上一页</button>
      <button class="button secondary small" data-action="bank-next" ${bankPage >= totalPages - 1 ? 'disabled' : ''}>下一页</button>
    </div>`;
}

function renderProgress() {
  const counts = stats(state);
  const mastered = counts.mastered + counts.applied;
  const plan = getPlan(state, Date.now());
  const schedule = new Map();
  for (const task of plan.upcoming) {
    const label = dueLabel(task.dueAt);
    schedule.set(label, (schedule.get(label) || 0) + 1);
  }
  main.innerHTML = `<section class="page-title"><h1>学习进度</h1>
    <p>听音和看词都经过延迟回忆，才计入已掌握。</p></section>
  <div class="dashboard-grid">
    <section class="panel"><h2>掌握情况</h2>
      <div class="progress-summary">
        <div class="ring" style="--percentage:${mastered}" role="img" aria-label="已掌握 ${mastered}%"><div class="ring-inner">${mastered}%</div></div>
        <div><p class="progress-number">${mastered} / 100</p><p class="panel-note">已掌握，含会运用的单词</p></div>
      </div>
      <ul class="progress-list">${Object.entries(counts).map(([key, count]) =>
        `<li><span class="tag ${key}">${statusLabels[key]}</span><strong>${count} 个</strong></li>`).join('')}</ul>
    </section>
    <section class="panel"><h2>复习安排</h2>
      ${plan.dueCount ? `<p class="panel-note">${plan.dueCount} 道题现在可以复习。</p>` : ''}
      ${schedule.size ? `<ul class="timeline">${[...schedule].slice(0, 4).map(([label, count]) =>
        `<li>${icon('clock', 16)}<strong>${label}</strong><span class="count">${count} 道题</span></li>`).join('')}</ul>`
        : '<p class="panel-note">完成练习后，复习时间会列在这里。</p>'}
      <button class="button ghost small schedule-action" data-action="reminder">${icon('bell', 15)}加到日历</button>
    </section>
  </div>
  <details class="panel model-note">
    <summary>掌握如何判定</summary>
    <p>提示、直接看答案、短时间内重复和多次重听计为巩固练习。看词和听音都需要跨天独立答对，并达到掌握证据门槛。「会运用」还需要跨天在新句子中独立填对目标词。</p>
    <p>FSRS-6 分开安排听音和看词复习，目标回忆率为 ${Math.round(RETENTION * 100)}%。HLR 并行记录预测，当前积累了 ${state.hlr.samples} 条可比较记录。BKT 用于累积掌握证据。</p>
  </details>`;
}

function begin() {
  refreshState();
  const plan = getPlan(state, Date.now());
  if (plan.round.length === 0) {
    go('today');
    return;
  }
  session = { tasks: plan.round, index: 0, outcomes: [], turn: null };
  page = 'study';
  makeTurn();
  render();
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
}

function makeTurn() {
  const task = session.tasks[session.index];
  session.turn = {
    started: performance.now(), hints: 0, listens: 0, answer: '',
    contextIndex: task.kind === 'transfer' ? nextContext(state, task.id) : null,
    result: null, playing: false, audioError: false,
  };
}

function studyFrame(content) {
  const { index, tasks, turn } = session;
  const completed = index + Number(turn.result !== null);
  return `<div class="study-wrap">
    <div class="study-top">
      <button class="button quiet small" data-route="today">${icon('left', 17)}返回今日</button>
      <span class="study-count">第 ${index + 1} / ${tasks.length} 张</span>
    </div>
    <div class="progress-bar" role="progressbar" aria-label="本轮进度" aria-valuemin="0" aria-valuemax="${tasks.length}" aria-valuenow="${completed}">
      <span style="width:${completed / tasks.length * 100}%"></span>
    </div>
    <article class="panel study-card">${content}</article>
  </div>`;
}

function renderStudy() {
  const task = session.tasks[session.index];
  const word = WORD_BY_ID[task.id];
  const turn = session.turn;
  const [label, symbol, tone] = taskLabels[task.kind];
  if (turn.result) {
    renderFeedback(task, word, turn);
    return;
  }
  const canAnswer = task.kind !== 'listening' || turn.listens > 0;
  const prompt = task.kind === 'listening' ? `<div class="listen-prompt">
      <button class="button primary play-main" type="button" data-audio="${word.id}" data-listen="1" aria-label="播放单词发音">${icon('play', 24)}</button>
      <div><h1>先听发音</h1><p id="play-status" aria-live="polite">${turn.listens ? `已播放 ${turn.listens} 次` : '点击播放，再回忆词义'}</p></div>
    </div>`
    : task.kind === 'transfer'
      ? `<h1 class="context-sentence" lang="en">${escapeHtml(word.contexts[turn.contextIndex]).replace('____', '<span class="blank">____</span>')}</h1>`
      : `<h1 lang="en">${word.id}</h1><p class="ipa">/${word.ipa}/</p>`;
  main.innerHTML = studyFrame(`<div class="study-badges">
      <span class="tag ${tone}">${icon(symbol, 14)}${label}</span>
      <span class="tag neutral">${task.isNew ? '新词' : '到期复习'}</span>
    </div>
    <div class="study-prompt ${task.kind === 'transfer' ? 'transfer-prompt' : ''}">${prompt}</div>
    <form id="answer-form">
      <label class="answer-label" for="answer">${task.kind === 'transfer' ? '写出学过的目标词' : '试着写出它的中文意思'}</label>
      <input class="answer-input" id="answer" type="text" autocomplete="off" spellcheck="false" maxlength="100"
        value="${escapeHtml(turn.answer)}" ${canAnswer ? '' : 'disabled'}
        placeholder="${task.kind === 'transfer' ? '输入英文单词' : '输入一个词义即可'}">
      ${turn.hints ? `<p class="hint"><strong>提示</strong> ${escapeHtml(task.kind === 'transfer' ? word.meaning : word.cue)}</p>` : ''}
      <p id="audio-error" class="hint" role="status" ${turn.audioError ? '' : 'hidden'}>音频暂时无法播放，可以重试或返回今日学习。</p>
      <div class="study-actions">
        <button class="button ghost hint-button" type="button" data-action="${turn.hints ? 'reveal' : 'hint'}" ${canAnswer ? '' : 'disabled'}>${icon('bulb', 16)}${turn.hints ? '直接看答案' : '看提示'}</button>
        <button class="button quiet" type="button" data-action="skip" ${canAnswer ? '' : 'disabled'}>想不起来</button>
        <button class="button primary" type="submit" id="check-answer" ${canAnswer && turn.answer.trim() ? '' : 'disabled'}>核对答案${icon('arrow', 16)}</button>
      </div>
    </form>`);
}

function renderFeedback(task, word, turn) {
  const result = turn.result;
  const correct = result.correct;
  const tone = result.independent && correct ? 'green' : 'amber';
  const title = !result.independent ? '已记录巩固练习'
    : result.applied ? '新语境填词正确'
      : correct ? '独立回忆正确'
        : turn.answer && turn.mode === 'input' ? '释义未匹配' : '稍后再试';
  const feedbackTitle = task.kind === 'transfer' && result.independent && !correct && turn.mode === 'input'
    ? '拼写未匹配' : title;
  const next = result.dueAt ? `<span>${icon('clock', 15)}下次复习 ${dueLabel(result.dueAt)}</span>` : '';
  const example = task.kind === 'transfer'
    ? escapeHtml(word.contexts[turn.contextIndex]).replace('____', `<b>${word.id}</b>`)
    : escapeHtml(word.example);
  main.innerHTML = studyFrame(`<span class="tag ${tone}">${icon(result.independent && correct ? 'check' : 'loop', 15)}${feedbackTitle}</span>
    <div class="study-prompt">
      <div class="feedback-word"><h1 lang="en">${word.id}</h1>
        <button class="button icon-button" data-audio="${word.id}" aria-label="播放单词发音">${icon('volume', 20)}</button></div>
      <p class="ipa">/${word.ipa}/</p>
    </div>
    <p class="meaning"><span class="pos">${word.pos}</span>${escapeHtml(word.meaning)}</p>
    <p class="aliases">也可表达为 ${word.aliases.slice(0, 3).map(escapeHtml).join('、')}</p>
    ${turn.mode === 'input' && !correct ? `<p class="result-note">你的答案 ${escapeHtml(turn.answer)}</p>` : ''}
    <p class="study-example" lang="en">${example}</p>
    <p class="scene"><strong>记忆场景</strong>${escapeHtml(word.cue)}</p>
    <div class="feedback-caption">${next}<span>${icon('layers', 15)}${statusLabels[result.status]}</span></div>
    <div class="study-actions"><button class="button primary" data-action="next">
      ${session.index + 1 === session.tasks.length ? '完成本轮' : '下一题'}${icon('arrow', 16)}
    </button></div>`);
  main.querySelector('[data-action="next"]').focus({ preventScroll: true });
}

function submit(mode) {
  const { turn } = session;
  const task = session.tasks[session.index];
  if (turn.result || (task.kind === 'listening' && turn.listens === 0)) return;
  if (mode === 'input' && !turn.answer.trim()) return;
  refreshState();
  const result = recordAttempt(state, task, {
    at: Date.now(), answer: turn.answer, mode, hints: turn.hints, listens: turn.listens,
    responseMs: Math.round(performance.now() - turn.started), contextIndex: turn.contextIndex,
  });
  if (!result) {
    toast('这张卡片的复习安排已更新。');
    advance();
    return;
  }
  turn.result = result;
  turn.mode = mode;
  session.outcomes.push(result);
  saveState();
  renderStudy();
}

function showHint() {
  const { turn } = session;
  const task = session.tasks[session.index];
  if (turn.result || turn.hints || (task.kind === 'listening' && !turn.listens)) return;
  turn.hints = 1;
  refreshState();
  markExposure(state, task.id, Date.now());
  saveState();
  renderStudy();
  $('#answer').focus({ preventScroll: true });
}

function advance() {
  stopAudio();
  session.index += 1;
  if (session.index >= session.tasks.length) {
    page = 'done';
    renderDone();
  } else {
    makeTurn();
    renderStudy();
  }
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
}

function renderDone() {
  const now = Date.now();
  const plan = getPlan(state, now);
  const correct = session.outcomes.filter(item => item.independent && item.correct).length;
  const next = plan.upcoming[0];
  const dueNow = plan.dueCount > 0;
  main.innerHTML = `<div class="study-wrap">
    <section class="panel end-card">
      <span class="icon-tile green">${icon('check', 25)}</span>
      <h1>本轮完成</h1>
      <p class="panel-note">${dueNow ? `还有 ${plan.dueCount} 道到期题。`
        : next ? `下次复习 ${dueLabel(next.dueAt, now)}` : '可以返回今日学习查看安排。'}</p>
      <div class="metrics">
        ${metric('练习完成', session.outcomes.length, '张', 'layers', 'blue')}
        ${metric('独立答对', correct, '张', 'check', 'green')}
        ${metric('到期复习', plan.dueCount, '道', 'clock', 'amber')}
      </div>
      <div class="study-actions">
        <button class="button secondary" data-action="reminder">${icon('bell', 16)}加到日历</button>
        <button class="button primary" ${dueNow ? 'data-action="begin"' : 'data-route="today"'}>${dueNow ? '继续复习' : '返回今日'}${icon('arrow', 16)}</button>
      </div>
    </section>
  </div>`;
}

function openDialog(title, contents) {
  modal.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${title}</h2>
    <button type="button" class="button quiet icon-button" data-action="close-dialog" aria-label="关闭">${icon('x', 20)}</button>
  </div>${contents}`;
  if (!modal.open) modal.showModal();
}

function showWord(id) {
  const word = WORD_BY_ID[id];
  if (!word) return;
  refreshState();
  markExposure(state, id, Date.now());
  saveState();
  const card = state.cards[id];
  openDialog(word.id, `<p class="ipa">/${word.ipa}/
      <button class="button ghost small" data-audio="${id}" aria-label="播放单词发音">${icon('volume', 19)}</button></p>
    <p class="meaning"><span class="pos">${word.pos}</span>${escapeHtml(word.meaning)}</p>
    <p class="aliases">${word.aliases.map(escapeHtml).join('、')}</p>
    <p class="study-example" lang="en">${escapeHtml(word.example)}</p>
    <p class="scene"><strong>记忆场景</strong>${escapeHtml(word.cue)}</p>
    <div class="feedback-caption"><span class="tag ${wordStatus(card)}">${statusLabels[wordStatus(card)]}</span>
      ${card.reading.dueAt ? `<span>${icon('book', 15)}看词 ${dueLabel(card.reading.dueAt)}</span>` : ''}
      ${card.listening.dueAt ? `<span>${icon('ear', 15)}听音 ${dueLabel(card.listening.dueAt)}</span>` : ''}
    </div>`);
}

function showReminder() {
  const next = getPlan(state, Date.now()).upcoming[0];
  openDialog('复习提醒', `<p class="dialog-text">下载日历文件并导入日历。日历会按你选的时间发出提醒。</p>
    <div class="dialog-row"><label for="reminder-time">每日复习时间</label>
      <input id="reminder-time" class="time-input" type="time" value="${escapeHtml(state.reminderTime)}" required></div>
    <div class="dialog-actions">
      <button class="button primary" data-action="calendar-daily">${icon('download', 16)}下载每日提醒</button>
      ${next ? `<button class="button secondary" data-action="calendar-next">下载下次提醒</button>` : ''}
    </div>
    ${next ? `<p class="panel-note">下次复习 ${dueLabel(next.dueAt)}</p>` : ''}`);
}

function icsUtc(at) {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsLocal(date) {
  const two = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}T${two(date.getHours())}${two(date.getMinutes())}00`;
}

function foldIcs(line) {
  const encoder = new TextEncoder();
  let folded = '';
  let width = 0;
  for (const character of line) {
    const bytes = encoder.encode(character).length;
    if (width + bytes > 75) {
      folded += '\r\n ';
      width = 1;
    }
    folded += character;
    width += bytes;
  }
  return folded;
}

function saveCalendar(recurring) {
  refreshState();
  const now = Date.now();
  let start;
  let uid;
  if (recurring) {
    const input = $('#reminder-time');
    if (!input.reportValidity()) return;
    state.reminderTime = input.value;
    saveState();
    const [hours, minutes] = input.value.split(':').map(Number);
    const first = new Date(now);
    first.setHours(hours, minutes, 0, 0);
    if (first.getTime() <= now) first.setDate(first.getDate() + 1);
    start = icsLocal(first);
    uid = `daily-${hours}-${minutes}`;
  } else {
    const next = getPlan(state, now).upcoming[0];
    if (!next) {
      toast('当前没有可添加的复习时间。');
      showReminder();
      return;
    }
    start = icsUtc(next.dueAt);
    uid = String(next.dueAt);
  }

  const url = location.origin + location.pathname;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wordloop//Vocabulary Review//ZH', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${uid}@wordloop`, `DTSTAMP:${icsUtc(now)}`, `DTSTART:${start}`,
    'DURATION:PT5M', ...(recurring ? ['RRULE:FREQ=DAILY'] : []),
    'SUMMARY:词循 · 英语难词复习', `DESCRIPTION:打开词循复习到期词。\\n${url}`, `URL:${url}`,
    'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:打开词循复习到期词',
    'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
  ];
  const blob = new Blob([lines.map(foldIcs).join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = recurring ? 'wordloop-daily.ics' : 'wordloop-next-review.ics';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast('请将下载的文件导入日历。');
}

function stopAudio() {
  player?.pause();
  player = null;
}

async function playWord(button) {
  const { audio: id, listen } = button.dataset;
  const turn = listen ? session?.turn : null;
  if (turn?.playing) return;
  if (turn) turn.playing = true;
  stopAudio();
  player = new Audio(`./audio/${id}.mp3`);
  try {
    await player.play();
    if (turn && turn === session?.turn && !turn.result) {
      turn.listens += 1;
      turn.audioError = false;
      $('#play-status').textContent = `已播放 ${turn.listens} 次`;
      $('#audio-error').hidden = true;
      $('#answer').disabled = false;
      $('#check-answer').disabled = !turn.answer.trim();
      main.querySelectorAll('[data-action="skip"], [data-action="hint"], [data-action="reveal"]').forEach(node => {
        node.disabled = false;
      });
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (turn && turn === session?.turn && !turn.result) {
      turn.audioError = true;
      $('#audio-error').hidden = false;
    } else {
      toast('发音暂时无法播放，请稍后再试。');
    }
  } finally {
    if (turn) turn.playing = false;
  }
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3700);
}

document.addEventListener('click', event => {
  const routeLink = event.target.closest('[data-route]');
  if (routeLink && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
    event.preventDefault();
    go(routeLink.dataset.route);
    return;
  }
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  const { word, audio, action, filter: selected } = button.dataset;
  if (word) showWord(word);
  if (audio) void playWord(button);
  if (selected) {
    filter = selected;
    bankPage = 0;
    document.querySelectorAll('[data-filter]').forEach(chip => {
      chip.setAttribute('aria-pressed', String(chip.dataset.filter === filter));
    });
    updateBank();
  }
  switch (action) {
    case 'begin': begin(); break;
    case 'hint': showHint(); break;
    case 'skip': submit('skip'); break;
    case 'reveal': submit('reveal'); break;
    case 'next': advance(); break;
    case 'reminder': showReminder(); break;
    case 'close-dialog': modal.close(); break;
    case 'calendar-daily': saveCalendar(true); break;
    case 'calendar-next': saveCalendar(false); break;
    case 'bank-prev':
    case 'bank-next':
      bankPage += action === 'bank-next' ? 1 : -1;
      updateBank();
      main.querySelector(`[data-action="${action}"]:not(:disabled)`)?.focus();
      break;
  }
});

document.addEventListener('input', event => {
  if (event.target.id === 'word-search') {
    query = event.target.value;
    bankPage = 0;
    updateBank();
  }
  if (event.target.id === 'answer' && session?.turn) {
    session.turn.answer = event.target.value;
    $('#check-answer').disabled = !session.turn.answer.trim();
  }
});

document.addEventListener('keydown', event => {
  if (event.target.id === 'answer' && event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) {
    event.preventDefault();
  }
});

document.addEventListener('submit', event => {
  if (event.target.id === 'answer-form') {
    event.preventDefault();
    submit('input');
  }
});

window.addEventListener('popstate', () => go(route(), false));
window.addEventListener('hashchange', () => {
  if (route() !== currentNav()) go(route(), false);
});
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  refreshState();
  if (page === 'today' && !modal.open) renderToday();
  if (page === 'words' && !modal.open) updateBank();
  if (page === 'progress' && !modal.open) renderProgress();
});
function refreshSchedule() {
  if (page !== 'today' || modal.open) return;
  const now = Date.now();
  if (todayStamp(getPlan(state, now), now) !== planStamp) renderToday();
}
window.addEventListener('focus', refreshSchedule);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSchedule(); });
setInterval(refreshSchedule, 10_000);
enableDepthEffects(main);
render();
