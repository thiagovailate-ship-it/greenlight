/* ============================================================================
   Greenlight — painel do agente ao vivo.
   Fala com o servidor local (/api/*); sem build, sem dependências.
   Todo texto vem do servidor e é inserido com textContent (nunca innerHTML).
   ========================================================================== */
(function () {
  'use strict';

  var root = document.querySelector('[data-agent]');
  if (!root) return;

  var els = {
    pill: document.getElementById('agent-pill'),
    pillText: document.getElementById('agent-pill-text'),
    ruleCount: document.getElementById('agent-rule-count'),
    scenarios: document.getElementById('agent-scenarios'),
    diff: document.getElementById('agent-diff'),
    diffMeta: document.getElementById('agent-diff-meta'),
    run: document.getElementById('agent-run'),
    reset: document.getElementById('agent-reset'),
    verdict: document.getElementById('agent-verdict'),
    verdictLabel: document.getElementById('agent-verdict-label'),
    verdictReason: document.getElementById('agent-verdict-reason'),
    stages: document.getElementById('agent-stages'),
    checks: document.getElementById('agent-checks'),
    summary: document.getElementById('agent-summary'),
    findings: document.getElementById('agent-findings'),
    result: document.querySelector('.agent__result'),
    engine: document.getElementById('agent-engine'),
  };

  if (!els.diff || !els.run) return;

  var SEVERITY = {
    critical: 'crítico',
    high: 'alto',
    medium: 'médio',
    low: 'baixo',
    info: 'info',
  };
  var CHECK_ICON = { pass: '✓', fail: '✕', warn: '!', skip: '–' };
  var STAGE_ICON = { pending: '·', running: '◌', done: '✓', warn: '!' };

  var state = {
    scenarios: [],
    scenario: null,
    originalDiff: '',
    review: null,
    running: false,
    controller: null,
    started: false,
    stages: new Map(),
    tick: null,
    startedAt: 0,
  };

  /* ------------------------------------------------------------- helpers -- */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function formatMs(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    if (ms < 1000) return Math.max(1, Math.round(ms)) + 'ms';
    return (ms / 1000).toFixed(1).replace('.', ',') + 's';
  }

  async function fetchJson(url, options) {
    var response = await fetch(url, options);
    var data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (!response.ok) {
      var message = data && data.error ? data.error : 'erro ' + response.status;
      var failure = new Error(message);
      failure.status = response.status;
      failure.code = data && data.code;
      throw failure;
    }
    return data;
  }

  function setPill(text, status) {
    if (els.pillText) els.pillText.textContent = text;
    if (els.pill) els.pill.dataset.state = status || 'ready';
  }

  function diffStats(text) {
    var files = 0;
    var adds = 0;
    var dels = 0;
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (line.indexOf('diff --git ') === 0) files += 1;
      else if (line.charAt(0) === '+' && line.indexOf('+++ ') !== 0) adds += 1;
      else if (line.charAt(0) === '-' && line.indexOf('--- ') !== 0) dels += 1;
    }
    return { files: files, adds: adds, dels: dels };
  }

  function updateMeta() {
    if (!els.diffMeta) return;
    var stats = diffStats(els.diff.value);
    var edited = state.originalDiff && els.diff.value !== state.originalDiff ? ' · editado' : '';
    els.diffMeta.textContent =
      (stats.files || 0) + (stats.files === 1 ? ' arquivo' : ' arquivos') + ' · +' + stats.adds + ' −' + stats.dels + edited;
  }

  function clearResults(message) {
    state.stages.clear();
    state.review = null;
    if (els.stages) els.stages.replaceChildren();
    if (els.checks) els.checks.replaceChildren();
    if (els.summary) {
      els.summary.hidden = true;
      els.summary.textContent = '';
    }
    if (els.verdict) els.verdict.dataset.status = 'idle';
    if (els.verdictLabel) els.verdictLabel.textContent = 'Aguardando o disparo';
    if (els.verdictReason) els.verdictReason.textContent = 'O pipeline mostra cada etapa assim que ela termina.';
    if (els.findings) {
      els.findings.replaceChildren(
        el('p', 'agent__empty', message || 'Nada foi revisado ainda. Dispare o primeiro PR.'),
      );
    }
  }

  /* ------------------------------------------------------------ cenários -- */
  function renderScenarios() {
    if (!els.scenarios) return;
    els.scenarios.replaceChildren();
    for (var i = 0; i < state.scenarios.length; i += 1) {
      (function (scenario) {
        var button = el('button', 'agent__tab');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(state.scenario && state.scenario.id === scenario.id));
        if (scenario.note) button.title = scenario.note;
        button.appendChild(el('span', 'agent__tab-title', scenario.title));
        if (scenario.subtitle) button.appendChild(el('span', 'agent__tab-sub', scenario.subtitle));
        button.addEventListener('click', function () {
          selectScenario(scenario);
        });
        els.scenarios.appendChild(button);
      })(state.scenarios[i]);
    }
  }

  async function selectScenario(scenario) {
    state.scenario = scenario;
    renderScenarios();
    try {
      var response = await fetch(scenario.url, { headers: { accept: 'text/plain' } });
      if (!response.ok) throw new Error('não foi possível carregar o exemplo');
      var text = await response.text();
      state.originalDiff = text;
      els.diff.value = text;
      updateMeta();
      clearResults('Pronto para revisar “' + scenario.title + '”.');
      await runReview();
    } catch (error) {
      clearResults('Falha ao carregar o exemplo: ' + error.message);
      setPill('exemplo indisponível', 'offline');
    }
  }

  /* ------------------------------------------------------------- pipeline -- */
  function renderStage(event) {
    if (!els.stages) return;
    var entry = state.stages.get(event.id) || { label: event.label };
    entry.label = event.label || entry.label;
    entry.status = event.status;
    entry.detail = event.detail || entry.detail || '';
    entry.ms = typeof event.ms === 'number' ? event.ms : entry.ms;
    state.stages.set(event.id, entry);

    var item = els.stages.querySelector('[data-stage="' + event.id + '"]');
    if (!item) {
      item = el('li', 'agent__stage');
      item.dataset.stage = event.id;
      item.appendChild(el('span', 'agent__stage-icon'));
      item.appendChild(el('span', 'agent__stage-label'));
      item.appendChild(el('span', 'agent__stage-detail'));
      item.appendChild(el('span', 'agent__stage-ms'));
      els.stages.appendChild(item);
    }
    item.dataset.status = entry.status;
    item.querySelector('.agent__stage-icon').textContent = STAGE_ICON[entry.status] || '·';
    item.querySelector('.agent__stage-label').textContent = entry.label;
    item.querySelector('.agent__stage-detail').textContent = entry.detail || '';
    item.querySelector('.agent__stage-ms').textContent =
      entry.status === 'done' && entry.ms !== undefined ? formatMs(entry.ms) : '';
  }

  function renderChecks(checks) {
    if (!els.checks) return;
    els.checks.replaceChildren();
    (checks || []).forEach(function (check) {
      var item = el('li', 'agent__check');
      item.dataset.status = check.status;
      item.appendChild(el('span', 'agent__check-icon', CHECK_ICON[check.status] || '·'));
      item.appendChild(el('span', 'agent__check-label', check.label));
      item.appendChild(el('span', 'agent__check-summary', check.summary));
      if (typeof check.findings === 'number') {
        item.appendChild(el('span', 'agent__check-count', String(check.findings)));
      }
      els.checks.appendChild(item);
    });
  }

  function renderVerdict(review) {
    if (!els.verdict) return;
    els.verdict.dataset.status = review.verdict.status;
    els.verdictLabel.textContent = review.verdict.label;
    els.verdictReason.textContent = review.verdict.reason + ' · ' + formatMs(review.durationMs);
    if (els.engine) {
      var llm = review.engine.llm;
      var llmLabel =
        llm.status === 'ok'
          ? llm.provider + '/' + llm.model
          : llm.status === 'failed'
            ? 'falhou'
            : 'off';
      els.engine.textContent =
        'motor v' +
        review.engine.version +
        ' · ' +
        review.engine.rules +
        ' regras · failOn ' +
        review.config.failOn +
        ' · LLM ' +
        llmLabel +
        ' · ' +
        formatMs(review.durationMs);
    }
  }

  function actionButton(label, className, onClick) {
    var button = el('button', className, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function copyButton(code) {
    return actionButton('Copiar', 'btn-mini', function (event) {
      var button = event.currentTarget;
      var done = function () {
        button.textContent = 'Copiado';
        setTimeout(function () {
          button.textContent = 'Copiar';
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done, function () {
          button.textContent = 'Falhou';
        });
      } else {
        button.textContent = 'Indisponível';
      }
    });
  }

  function suggestionBlock(suggestion, finding) {
    var wrapper = el('details', 'agent__suggestion');
    if (suggestion.applyable && suggestion.mode === 'replace') wrapper.open = true;
    var summary = el('summary', 'agent__suggestion-summary');
    summary.appendChild(el('span', 'agent__suggestion-title', suggestion.title || 'Correção sugerida'));
    if (suggestion.filename) summary.appendChild(el('span', 'agent__suggestion-file', suggestion.filename));
    wrapper.appendChild(summary);

    var pre = el('pre', 'agent__code');
    pre.appendChild(el('code', null, suggestion.code));
    wrapper.appendChild(pre);

    var actions = el('div', 'agent__suggestion-actions');
    actions.appendChild(copyButton(suggestion.code));
    if (suggestion.applyable && suggestion.mode === 'replace') {
      actions.appendChild(
        actionButton('Aplicar correção', 'btn-mini btn-mini--accent', function () {
          applyFix(finding);
        }),
      );
    }
    wrapper.appendChild(actions);
    return wrapper;
  }

  function findingCard(finding) {
    var card = el('article', 'agent__finding');
    card.dataset.severity = finding.severity;

    var head = el('div', 'agent__finding-head');
    head.appendChild(el('span', 'agent__sev', SEVERITY[finding.severity] || finding.severity));
    head.appendChild(el('code', 'agent__rule', finding.ruleId + (finding.source === 'llm' ? ' · llm' : '')));
    head.appendChild(el('span', 'agent__finding-loc', finding.file + ':' + finding.line));
    card.appendChild(head);

    card.appendChild(el('h3', 'agent__finding-title', finding.title));
    card.appendChild(el('p', 'agent__finding-message', finding.message));
    if (finding.why) card.appendChild(el('p', 'agent__finding-why', finding.why));

    if (finding.code) {
      var pre = el('pre', 'agent__code');
      pre.appendChild(el('code', null, finding.code));
      card.appendChild(pre);
    }

    if (finding.suggestion) card.appendChild(suggestionBlock(finding.suggestion, finding));

    var actions = el('div', 'agent__finding-actions');
    actions.appendChild(
      actionButton('Dispensar', 'btn-mini', function () {
        dismiss(finding);
      }),
    );
    card.appendChild(actions);
    return card;
  }

  function renderFindings(findings, review) {
    if (!els.findings) return;
    els.findings.replaceChildren();
    var list = Array.isArray(findings) ? findings : [];

    if (list.length === 0) {
      var empty = el('div', 'agent__empty agent__empty--ok');
      empty.appendChild(el('p', null, 'Nenhum problema encontrado neste diff.'));
      var suppressed = review && review.suppressed ? review.suppressed.total : 0;
      empty.appendChild(
        el(
          'p',
          'agent__empty-sub',
          suppressed > 0
            ? 'Sinal verde com ' + suppressed + (suppressed === 1 ? ' achado dispensado' : ' achados dispensados') + '.'
            : 'Sinal verde — todas as checagens passaram.',
        ),
      );
      els.findings.appendChild(empty);
      return;
    }

    var head = el('p', 'agent__findings-head');
    head.textContent =
      list.length +
      (list.length === 1 ? ' achado' : ' achados') +
      (review && review.suppressed && review.suppressed.total
        ? ' · ' + review.suppressed.total + ' dispensado' + (review.suppressed.total === 1 ? '' : 's')
        : '');
    els.findings.appendChild(head);

    var limit = 12;
    list.slice(0, limit).forEach(function (finding) {
      els.findings.appendChild(findingCard(finding));
    });
    if (list.length > limit) {
      els.findings.appendChild(
        el('p', 'agent__empty-sub', '… e mais ' + (list.length - limit) + '. Veja o JSON em /api/review.'),
      );
    }
  }

  function handleEvent(name, data) {
    if (name === 'stage') renderStage(data);
    else if (name === 'checks') renderChecks(data);
    else if (name === 'findings') renderFindings(data, state.review);
    else if (name === 'summary' && els.summary) {
      els.summary.hidden = false;
      els.summary.textContent = data;
    } else if (name === 'done') {
      state.review = data.review;
      renderVerdict(data.review);
      renderFindings(data.review.findings, data.review);
      if (data.review.summary && els.summary) {
        els.summary.hidden = false;
        els.summary.textContent = data.review.summary;
      }
    } else if (name === 'error') {
      showError(data && data.error ? data.error : 'Falha ao revisar.');
    }
  }

  function parseBlock(block) {
    var name = 'message';
    var data = '';
    var lines = block.split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (line.indexOf('event:') === 0) name = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
    }
    if (!data) return null;
    try {
      return { name: name, data: JSON.parse(data) };
    } catch (error) {
      return null;
    }
  }

  function showError(message, code) {
    if (els.verdict) els.verdict.dataset.status = 'error';
    if (els.verdictLabel) els.verdictLabel.textContent = 'Não foi possível revisar';
    if (els.verdictReason) els.verdictReason.textContent = message;
    if (els.findings) {
      var box = el('p', 'agent__empty agent__empty--error', message);
      if (code) box.appendChild(el('span', 'agent__empty-sub', ' código: ' + code));
      els.findings.replaceChildren(box);
    }
    setPill('revisão interrompida', 'offline');
  }

  async function streamReview(diff) {
    var response = await fetch('/api/review/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ diff: diff, scenarioId: state.scenario ? state.scenario.id : null }),
      signal: state.controller.signal,
    });

    if (!response.ok) {
      var payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      throw new Error(payload && payload.error ? payload.error : 'servidor respondeu ' + response.status);
    }
    if (!response.body || !response.body.getReader) {
      return false;
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var index = buffer.indexOf('\n\n');
      while (index !== -1) {
        var block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (block.charAt(0) !== ':') {
          var parsed = parseBlock(block);
          if (parsed) handleEvent(parsed.name, parsed.data);
        }
        index = buffer.indexOf('\n\n');
      }
    }
    return true;
  }

  async function runReview() {
    if (state.running && state.controller) {
      state.controller.abort();
    }
    var runId = (state.runId || 0) + 1;
    state.runId = runId;
    var diff = els.diff.value;
    if (!diff.trim()) {
      showError('Cole um diff unificado antes de revisar.', 'EMPTY_DIFF');
      return;
    }

    state.running = true;
    state.controller = new AbortController();
    state.started = true;
    clearResults('Revisando…');
    renderChecks([]);
    els.run.disabled = true;
    els.run.setAttribute('aria-busy', 'true');
    els.diff.setAttribute('aria-busy', 'true');
    setPill('revisando…', 'running');

    var startedAt = Date.now();
    state.startedAt = startedAt;
    var tick = setInterval(function () {
      setPill('revisando… ' + formatMs(Date.now() - startedAt), 'running');
    }, 250);
    state.tick = tick;
    if (els.result) els.result.scrollTop = 0;

    var done = false;
    try {
      var streamed = await streamReview(diff);
      done = Boolean(state.review);
      if (!streamed) {
        var fallback = await fetchJson('/api/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ diff: diff, scenarioId: state.scenario ? state.scenario.id : null }),
        });
        state.review = fallback.review;
        renderChecks(fallback.review.checks);
        renderVerdict(fallback.review);
        renderFindings(fallback.review.findings, fallback.review);
        if (fallback.review.summary && els.summary) {
          els.summary.hidden = false;
          els.summary.textContent = fallback.review.summary;
        }
        done = true;
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      var message =
        error instanceof TypeError
          ? 'Sem conexão com o servidor do agente. Rode `npm start` e abra http://localhost:3000.'
          : error.message;
      showError(message, error.code);
    } finally {
      clearInterval(tick);
      if (state.runId !== runId) return; // outra revisão já assumiu o painel
      state.running = false;
      els.run.disabled = false;
      els.run.removeAttribute('aria-busy');
      els.diff.removeAttribute('aria-busy');
      if (done) {
        setPill('motor pronto · ' + formatMs(Date.now() - startedAt), 'ready');
      }
      els.diff.removeAttribute('aria-busy');
    }
  }

  /* --------------------------------------------------- aplicar / dispensar -- */
  async function applyFix(finding) {
    if (state.running) return;
    if (!finding || !finding.suggestion) return;
    setPill('aplicando correção…', 'running');
    try {
      var payload = await fetchJson('/api/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          diff: els.diff.value,
          file: finding.file,
          suggestion: finding.suggestion,
        }),
      });
      els.diff.value = payload.diff;
      updateMeta();
      await runReview();
    } catch (error) {
      showError('Não foi possível aplicar a correção: ' + error.message);
    }
  }

  async function dismiss(finding) {
    if (state.running) return;
    setPill('dispensando…', 'running');
    try {
      await fetchJson('/api/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ finding: finding, reason: 'dispensado no painel ao vivo' }),
      });
      await runReview();
    } catch (error) {
      showError('Não foi possível dispensar: ' + error.message);
    }
  }

  /* ----------------------------------------------------------------- init -- */
  async function init() {
    updateMeta();
    els.diff.addEventListener('input', updateMeta);
    els.diff.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        runReview();
      }
    });
    els.run.addEventListener('click', function () {
      runReview();
    });
    if (els.reset) {
      els.reset.addEventListener('click', function () {
        if (!state.originalDiff) return;
        els.diff.value = state.originalDiff;
        updateMeta();
        state.review = null;
        // Restaurar também limpa as dispensas da sessão, senão o exemplo
        // voltaria verde sem explicar por quê.
        fetch('/api/dismissed', { method: 'DELETE' })
          .catch(function () {
            return null;
          })
          .then(function () {
            runReview();
          });
      });
    }

    var health = null;
    try {
      health = await fetchJson('/api/health');
    } catch (error) {
      setPill('servidor fora do ar', 'offline');
      clearResults(
        'Este painel conversa com o servidor local do Greenlight. Rode `npm start` no repositório e abra http://localhost:3000.',
      );
      if (els.engine) els.engine.textContent = 'motor: offline';
      return;
    }

    var llm = health.llm || {};
    var llmLabel = llm.enabled ? llm.provider + '/' + llm.model : 'LLM off';
    setPill('motor v' + health.version + ' · ' + health.rules + ' regras · ' + llmLabel, 'ready');
    if (els.ruleCount) els.ruleCount.textContent = health.rules + ' regras';
    if (els.engine) {
      els.engine.textContent =
        'motor v' +
        health.version +
        ' · ' +
        health.rules +
        ' regras · índice ' +
        (health.index && health.index.learned ? 'aprendido' : 'ausente') +
        ' · ' +
        llmLabel;
    }

    try {
      var catalog = await fetchJson('/api/scenarios');
      state.scenarios = catalog.scenarios || [];
      renderScenarios();
    } catch (error) {
      state.scenarios = [];
    }

    if (state.scenarios.length > 0) {
      var first = state.scenarios[0];
      try {
        var response = await fetch(first.url, { headers: { accept: 'text/plain' } });
        var text = await response.text();
        state.scenario = first;
        state.originalDiff = text;
        els.diff.value = text;
        updateMeta();
        renderScenarios();
        clearResults('Pronto para revisar “' + first.title + '”.');
      } catch (error) {
        clearResults('Cole um diff e clique em “Revisar este PR”.');
      }
    }

    var section = document.getElementById('agent');
    if (section && 'IntersectionObserver' in window) {
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting || state.started) return;
            observer.disconnect();
            if (els.diff.value.trim()) runReview();
          });
        },
        { threshold: 0.25 },
      );
      observer.observe(section);
    }
  }

  init();
})();
