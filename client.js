/**
 * doc-workflow bundle — Client half: the "Docflow" right-sidebar tab.
 *
 * A read-only live dashboard for the docflow workflow state file
 * `<workspace>/.doc-workflow/state.json`, written by the host half of this
 * bundle (index.js). It discovers the state file in the Session workspace
 * (root `.doc-workflow/` or one level down per project, like graphify's
 * discovery), loads it through the workspaceFiles remote with the same
 * chunked readWholeFile used by the graphify client, and renders the stage
 * machine: objective + stage chips, a derived VERIFIED / VERIFYING /
 * conflict banner (integrity + logical consistency together), the gates
 * rail (understanding / gaps), verification results with per-entry pills
 * (failed / unanchored / unattested / suspect / external sources), the
 * useful / non-useful entry index with expandable details — external
 * sources carry an 'ext' badge since only a human can check them —,
 * pending new documents and the plan block.
 *
 * A ctx.timer interval re-stats the selected state file every 7 s and
 * reloads only when its version/bytes changed, so the panel follows the
 * agent's docflow calls with no manual click; "Refresh" rescans at any time.
 *
 * React renders everything; styles are a component-local <style> element
 * (unmount removes it — document.head is never touched). No JSX, no npm
 * dependencies — plain ES5 inside the factory, loaded via
 * window.__ModuleLoader__.
 *
 * @module @local/doc-workflow
 */
(function () {
  'use strict';
  var mod = window.__ModuleLoader__;
  if (!mod || typeof mod.load !== 'function') return;
  mod.load({
    id: '@local/doc-workflow',
    factory: function (require) {
      var React = require('react');
      var exports = {};

      var NS = 'docflowPanel';
      var TAB_ID = '@local/doc-workflow';
      var TAB_KIND = 'docflow';

      var CHUNK_BYTES = 1 << 20;    // 1 MiB byte-window per readBytes call
      var MAX_FILE_BYTES = 16 << 20; // refuse state files above 16 MiB
      var ROOT_STATE = '.doc-workflow/state.json';
      var POLL_MS = 7000;

      var COPY = {
        en: {
          'title': 'Docflow',
          'guide.title': 'Docflow',
          'guide.desc': 'Live view of the docflow document workflow of this workspace.',
          'refresh': 'Refresh',
          'loading': 'Loading workflow…',
          'read.error': 'Could not read the workflow state',
          'parse.error': 'Could not parse state.json',
          'state.kind': 'state.json is not a docflow workflow file',
          'project.root': 'this workspace',
          'objective': 'Objective',
          'updated': 'updated',
          'stage.reading': 'Reading',
          'stage.indexing': 'Indexing',
          'stage.consistency': 'Consistency',
          'stage.extract': 'Extract',
          'stage.verify': 'Verify',
          'stage.recheck': 'Re-check',
          'stage.gaps': 'Gaps',
          'stage.plan': 'Plan',
          'stage.done': 'Done',
          'stage.no-workflow': 'No workflow',
          'gates': 'Gates',
          'gate.understanding': 'Understanding',
          'gate.gaps': 'Missing information',
          'gate.locked': 'locked',
          'gate.open': 'open',
          'gate.asked': 'asked',
          'gate.pending': 'awaiting answers',
          'gate.answered': 'answered',
          'gate.reconfirm': '⚠ reconfirm with user',
          'gate.answers': 'answers',
          'verification': 'Verification',
          'ver.unverified': 'unverified',
          'ver.stale': 'stale',
          'ver.passed': 'passed',
          'ver.failed': 'failed',
          'ver.last': 'last run',
          'v.failed': 'failed',
          'v.unanchored': 'unanchored',
          'v.unattested': 'unattested',
          'v.suspect': 'suspect',
          'v.externals': 'external sources',
          'consistency': 'Logical consistency',
          'banner.verified': 'Verified',
          'banner.cons.pending': 'Integrity ok — logical consistency pending',
          'banner.conflict.a': 'Consistency: ',
          'banner.conflict.b': ' conflict(s) — re-check marked pairs',
          'banner.notverified': 'Verification not run / stale — data not verified',
          'status.verified': 'VERIFIED',
          'status.verifying': 'VERIFYING',
          'c.na': 'n/a',
          'c.pending': 'pending',
          'c.conflict': 'conflict',
          'c.passed': 'passed',
          'c.pairs': 'pairs',
          'c.conflicts': 'conflicting pairs',
          'entry.external': 'external source (to check)',
          'entries': 'Entries',
          'entries.useful': 'Useful',
          'entries.notuseful': 'Non-useful',
          'entries.none': 'no entries yet',
          'e.content': 'Content',
          'e.relevance': 'Relevance',
          'e.quote': 'Quote',
          'e.integrity': 'Integrity',
          'e.trust': 'Trustworthiness',
          'e.notverified': 'not verified',
          'e.notattested': 'not attested',
          'e.added': 'added',
          'plan': 'Plan',
          'plan.written': 'plan written',
          'pending.title': 'New documents pending',
          'empty.title': 'No docflow workflow in this workspace yet',
          'empty.body': 'Start one: ask the agent for a docflow objective.',
          'empty.hint.a': 'or call the ',
          'empty.hint.b': ' tool',
        },
        it: {
          'title': 'Docflow',
          'guide.title': 'Docflow',
          'guide.desc': 'Vista live del flusso di lavoro docflow sui documenti di questo workspace.',
          'refresh': 'Aggiorna',
          'loading': 'Caricamento del workflow…',
          'read.error': 'Impossibile leggere lo stato del workflow',
          'parse.error': 'Impossibile analizzare state.json',
          'state.kind': 'state.json non è un file di workflow docflow',
          'project.root': 'questo workspace',
          'objective': 'Obiettivo',
          'updated': 'aggiornato',
          'stage.reading': 'Lettura',
          'stage.indexing': 'Indicizzazione',
          'stage.consistency': 'Coerenza logica',
          'stage.extract': 'Estrazione',
          'stage.verify': 'Verifica',
          'stage.recheck': 'Ricontrollo',
          'stage.gaps': 'Lacune',
          'stage.plan': 'Piano',
          'stage.done': 'Fatto',
          'stage.no-workflow': 'Nessun workflow',
          'gates': 'Soglie',
          'gate.understanding': 'Comprensione',
          'gate.gaps': 'Informazioni mancanti',
          'gate.locked': 'bloccata',
          'gate.open': 'aperta',
          'gate.asked': 'chiesta',
          'gate.pending': 'in attesa di risposte',
          'gate.answered': 'risposta ricevuta',
          'gate.reconfirm': '⚠ da riconfermare',
          'gate.answers': 'risposte',
          'verification': 'Verifica',
          'ver.unverified': 'non verificata',
          'ver.stale': 'da rifare',
          'ver.passed': 'superata',
          'ver.failed': 'fallita',
          'ver.last': 'ultima esecuzione',
          'v.failed': 'falliti',
          'v.unanchored': 'senza àncora',
          'v.unattested': 'non attestati',
          'v.suspect': 'sospetti',
          'v.externals': 'fonti esterne',
          'consistency': 'Coerenza logica',
          'banner.verified': 'Verificato',
          'banner.cons.pending': 'Integrità ok — coerenza logica in sospeso',
          'banner.conflict.a': 'Coerenza: ',
          'banner.conflict.b': ' conflitto/i — ricontrolla le coppie segnate',
          'banner.notverified': 'Verifica non eseguita / obsoleta — dati non verificati',
          'status.verified': 'VERIFICATO',
          'status.verifying': 'IN VERIFICA',
          'c.na': 'n/a',
          'c.pending': 'in sospeso',
          'c.conflict': 'in conflitto',
          'c.passed': 'coerente',
          'c.pairs': 'coppie',
          'c.conflicts': 'coppie in conflitto',
          'entry.external': 'fonte esterna (da controllare)',
          'entries': 'Voci',
          'entries.useful': 'Utili',
          'entries.notuseful': 'Non utili',
          'entries.none': 'nessuna voce',
          'e.content': 'Contenuto',
          'e.relevance': 'Rilevanza',
          'e.quote': 'Citazione',
          'e.integrity': 'Integrità',
          'e.trust': 'Affidabilità',
          'e.notverified': 'non verificata',
          'e.notattested': 'non attestata',
          'e.added': 'aggiunta',
          'plan': 'Piano',
          'plan.written': 'piano scritto',
          'pending.title': 'Nuovi documenti in attesa',
          'empty.title': 'Nessun workflow docflow in questo workspace',
          'empty.body': 'Avviane uno: chiedi all’agente un obiettivo docflow.',
          'empty.hint.a': 'oppure richiama il ',
          'empty.hint.b': ' tool',
        },
      };

      var CSS = [
        '.dfp-root{height:100%;overflow-y:auto;padding:12px 14px;font-size:12.5px;line-height:1.45;' +
          'color:var(--dsw-alias-label-primary);background:var(--dsw-specific-sidebar-fill);' +
          'font-family:system-ui,-apple-system,sans-serif;}',
        '.dfp-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;}',
        '.dfp-title{font-size:13.5px;font-weight:650;}',
        '.dfp-sel{font:inherit;font-size:11.5px;color:inherit;background:var(--dsw-alias-bg-layer-1);' +
          'border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 6px;max-width:150px;}',
        '.dfp-btn{font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);' +
          'border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 10px;cursor:pointer;}',
        '.dfp-btn:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover);}',
        '.dfp-btn:disabled{opacity:.5;cursor:default;}',
        '.dfp-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;}',
        '.dfp-obj{color:var(--dsw-alias-label-secondary);font-size:11.5px;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;max-width:100%;}',
        '.dfp-chip{display:inline-block;padding:1px 9px;border-radius:999px;font-size:11px;' +
          'border:1px solid var(--dsw-alias-border-l2);white-space:nowrap;}',
        '.dfp-c-neutral{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',
        '.dfp-c-brand{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);' +
          'border-color:var(--dsw-alias-brand-primary);}',
        '.dfp-c-success{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}',
        '.dfp-c-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}',
        '.dfp-c-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}',
        '.dfp-rail{display:flex;align-items:center;flex-wrap:wrap;gap:3px;margin:10px 0 12px;}',
        '.dfp-step{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;' +
          'font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
        '.dfp-step-done{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);opacity:.55;}',
        '.dfp-step-cur{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);' +
          'background:var(--dsw-alias-bg-layer-2);font-weight:600;}',
        '.dfp-step-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);' +
          'background:var(--dsw-alias-bg-layer-2);font-weight:600;}',
        '.dfp-sep{color:var(--dsw-alias-label-tertiary);font-size:10px;padding:0 1px;}',
        '.dfp-sec{margin:14px 0 5px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;' +
          'text-transform:uppercase;letter-spacing:.5px;}',
        '.dfp-box{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);' +
          'border-radius:8px;padding:8px 10px;}',
        '.dfp-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:3px 0;}',
        '.dfp-lbl{color:var(--dsw-alias-label-secondary);font-size:11.5px;}',
        '.dfp-warnbadge{color:var(--dsw-alias-state-warn-primary);font-size:11px;}',
        '.dfp-pill{display:inline-block;font-family:ui-monospace,SFMono-Regular,monospace;font-size:10.5px;' +
          'line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);' +
          'color:var(--dsw-alias-label-secondary);}',
        '.dfp-pill-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
        '.dfp-pill-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
        '.dfp-pend{border-left:2px solid var(--dsw-alias-state-warn-primary);margin:6px 0;}',
        '.dfp-pend .dfp-sec{margin:0 0 4px;color:var(--dsw-alias-state-warn-primary);}',
        '.dfp-err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);' +
          'overflow-wrap:anywhere;margin-bottom:8px;}',
        '.dfp-entry{display:flex;align-items:center;gap:6px;padding:4px 4px;cursor:pointer;' +
          'border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0;}',
        '.dfp-entry:hover{background:var(--dsw-alias-interactive-bg-hover);}',
        '.dfp-id{flex:none;font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px;' +
          'padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);}',
        '.dfp-id-u{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}',
        '.dfp-id-n{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}',
        '.dfp-etitle{flex:1 1 60px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dfp-src{flex:0 1 auto;max-width:45%;font-family:ui-monospace,SFMono-Regular,monospace;font-size:10.5px;' +
          'color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dfp-dot{flex:none;width:7px;height:7px;border-radius:50%;}',
        '.dfp-dot-ok{background:var(--dsw-alias-state-success-primary);}',
        '.dfp-dot-failed{background:var(--dsw-alias-state-error-primary);}',
        '.dfp-dot-warn{background:var(--dsw-alias-state-warn-primary);}',
        '.dfp-dash{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;}',
        '.dfp-detail{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);' +
          'border-radius:8px;padding:8px 10px;margin:4px 0 6px;box-shadow:0 2px 8px rgba(0,0,0,.18);}',
        '.dfp-k{color:var(--dsw-alias-label-tertiary);font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin:7px 0 2px;}',
        '.dfp-v{overflow-wrap:anywhere;white-space:pre-wrap;}',
        '.dfp-quote{border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px;margin:2px 0;' +
          'color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;' +
          'max-height:160px;overflow-y:auto;font-size:11.5px;font-style:italic;}',
        '.dfp-ext{flex:none;font-size:9.5px;line-height:14px;padding:0 4px;border-radius:4px;' +
          'border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);' +
          'white-space:nowrap;}',
        '.dfp-code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;' +
          'background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);' +
          'border-radius:4px;padding:0 4px;}',
        '.dfp-mid{display:flex;align-items:center;justify-content:center;gap:9px;padding:34px 0;' +
          'color:var(--dsw-alias-label-secondary);}',
        '.dfp-spin{width:15px;height:15px;border:2px solid var(--dsw-alias-border-l2);' +
          'border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dfp-rot .8s linear infinite;}',
        '@keyframes dfp-rot{to{transform:rotate(360deg)}}',
        '.dfp-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:36px 16px;' +
          'text-align:center;color:var(--dsw-alias-label-secondary);}',
        '.dfp-empty b{color:var(--dsw-alias-label-primary);font-size:13.5px;}',
        '.dfp-none{color:var(--dsw-alias-label-tertiary);font-size:11.5px;padding:4px 0;}',
      ].join('\n');

      // ---------------------------------------------------------------- helpers
      function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
      function arr(v) { return Array.isArray(v) ? v : []; }
      function obj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null; }
      function fmtTime(v) {
        var s = str(v);
        if (!s) return '';
        var d = new Date(s);
        if (isNaN(d.getTime())) return s;
        try { return d.toLocaleString(); } catch (e) { return s; }
      }
      function midTruncate(s, max) {
        if (s.length <= max) return s;
        var tail = Math.ceil(max * 0.6);
        return s.slice(0, max - tail - 1) + '…' + s.slice(s.length - tail);
      }
      function known(table, name) { return table[name] ? true : false; }
      var STAGE_NAMES = { 'reading': 1, 'indexing': 1, 'consistency': 1, 'extract': 1, 'verify': 1, 'recheck': 1, 'gaps': 1, 'plan': 1, 'done': 1, 'no-workflow': 1 };
      var GATE_STATUS = { 'locked': 1, 'open': 1, 'asked': 1, 'pending': 1, 'answered': 1 };
      var VER_STATUS = { 'unverified': 1, 'stale': 1, 'passed': 1, 'failed': 1 };
      var CONS_STATUS = { 'n/a': 1, 'passed': 1, 'pending': 1, 'conflict': 1 };
      var STAGE_CHIP = { 'reading': 'dfp-c-neutral', 'indexing': 'dfp-c-neutral', 'consistency': 'dfp-c-brand', 'recheck': 'dfp-c-warn', 'gaps': 'dfp-c-brand', 'plan': 'dfp-c-brand', 'done': 'dfp-c-success' };
      var VER_CHIP = { 'unverified': 'dfp-c-neutral', 'stale': 'dfp-c-warn', 'passed': 'dfp-c-success', 'failed': 'dfp-c-error' };
      var GATE_CHIP = { 'locked': 'dfp-c-neutral', 'open': 'dfp-c-brand', 'asked': 'dfp-c-warn', 'pending': 'dfp-c-warn', 'answered': 'dfp-c-success' };
      var CONS_CHIP = { 'n/a': 'dfp-c-neutral', 'passed': 'dfp-c-success', 'pending': 'dfp-c-warn', 'conflict': 'dfp-c-error' };
      var STEPS = ['reading', 'indexing', 'consistency', 'gaps', 'plan', 'done'];

      /** Read one whole file through the chunked byte window (graphify pattern). */
      async function readWholeFile(remote, sessionId, path, signal) {
        var chunks = [];
        var offset = 0;
        var chunk = CHUNK_BYTES;
        for (;;) {
          if (signal && signal.aborted) throw new Error('aborted');
          var res = await remote.workspaceFiles.readBytes(sessionId, path, { range: { offset: offset, length: chunk } }, signal);
          if (!res.ok) {
            var msg = (res.error && res.error.message) || 'read failed';
            // The Host caps one readBytes window (e.g. 2 MiB); adapt and retry
            // the same offset instead of failing when our window is too big.
            var capMatch = /exceed(?:s)?\s+(?:\d+\s+bytes?\s+of\s+)?["']?[^"']*?(\d+)\s+byte(?:s)?\s+cap/i.exec(msg);
            if (capMatch && chunk > Number(capMatch[1])) {
              chunk = Math.max(64 << 10, Number(capMatch[1]));
              continue;
            }
            var e = new Error(msg); e.code = res.error && res.error.code; throw e;
          }
          var data = res.value.data;
          var bytes = typeof data === 'string' ? (function () { var a = new Uint8Array(data.length); for (var i = 0; i < data.length; i++) a[i] = data.charCodeAt(i) & 0xff; return a; })() : data;
          if (bytes.length === 0) break;
          chunks.push(bytes);
          offset += bytes.length;
          if (offset > MAX_FILE_BYTES) throw new Error('state.json exceeds ' + (MAX_FILE_BYTES >> 20) + ' MiB');
          if (res.value.eof) break;
        }
        var buf = new Uint8Array(offset);
        var p = 0;
        for (var c = 0; c < chunks.length; c++) { buf.set(chunks[c], p); p += chunks[c].length; }
        return new TextDecoder('utf-8').decode(buf);
      }

      async function statFile(remote, sessionId, path, signal) {
        try {
          var st = await remote.workspaceFiles.stat(sessionId, path, signal);
          return st && st.ok ? st : null;
        } catch (err) {
          if (err && String(err.message) === 'aborted') throw err;
          return null;
        }
      }

      /** Workspace paths of every docflow state file visible in the session. */
      async function discoverFiles(remote, sessionId, signal) {
        var probes = [ROOT_STATE];
        try {
          var top = await remote.workspaceFiles.list(sessionId, '', signal);
          if (top.ok) {
            var entries = top.value.entries || [];
            for (var i = 0; i < entries.length && i < 80; i++) {
              var ent = entries[i];
              if (!ent || ent.type !== 'directory') continue;
              var name = ent.name;
              if (!name || name.charAt(0) === '.' || name === 'node_modules') continue;
              probes.push(name + '/' + ROOT_STATE);
            }
          }
        } catch (err) { /* fall back to root probe only */ }
        var found = [];
        for (var j = 0; j < probes.length; j++) {
          if (signal && signal.aborted) break;
          try {
            var st = await remote.workspaceFiles.stat(sessionId, probes[j], signal);
            if (st && st.ok) found.push(probes[j]);
          } catch (err) { /* not here */ }
        }
        return found;
      }

      // ------------------------------------------------------------ apply
      exports.inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles', 'timer'];
      exports.apply = function (ctx) {
        var t = ctx.locale.bind(NS);

        // Shared slot the 7 s timer polls; the mounted panel keeps it fresh.
        var live = { sessionId: null, file: null, subs: [] };
        function subscribe(fn) {
          live.subs.push(fn);
          return function () { var i = live.subs.indexOf(fn); if (i !== -1) live.subs.splice(i, 1); };
        }
        function bumpAll() {
          for (var i = 0; i < live.subs.length; i++) { try { live.subs[i](); } catch (e) { /* ignore */ } }
        }

        function DocflowBody(props) {
          var sessionId = props.sessionId;
          var remote = ctx.remote;

          var _ui = React.useState({ phase: 'idle' });
          var ui = _ui[0], setUi = _ui[1];
          var _found = React.useState([]);
          var found = _found[0], setFound = _found[1];
          var _sel = React.useState(0);
          var sel = _sel[0], setSel = _sel[1];
          var _nonce = React.useState(0);
          var nonce = _nonce[0], setNonce = _nonce[1];
          var _open = React.useState(null);
          var openId = _open[0], setOpenId = _open[1];
          var _tick = React.useState(0);
          var tickv = _tick[0], setTickv = _tick[1];
          var ctrlRef = React.useRef(null);
          var fpRef = React.useRef(null);      // version:bytes of the loaded state
          var lastFileRef = React.useRef(null);
          var readyRef = React.useRef(false); // a state file is currently rendered

          // timer ticks (ctx.timer → subscription) re-run the check effect
          React.useEffect(function () {
            return subscribe(function () { setTickv(function (v) { return v + 1; }); });
          }, []);

          // discovery: on mount, session change and every manual Refresh
          React.useEffect(function () {
            if (!sessionId || !remote) return undefined;
            var ctrl = new AbortController();
            ctrlRef.current = ctrl;
            fpRef.current = null;
            readyRef.current = false;
            lastFileRef.current = null;
            setUi({ phase: 'loading' });
            discoverFiles(remote, sessionId, ctrl.signal).then(function (list) {
              if (ctrl.signal.aborted) return;
              setFound(list);
              setSel(0);
              if (list.length === 0) { live.sessionId = null; live.file = null; setUi({ phase: 'empty' }); }
            }).catch(function (err) {
              if (String(err && err.message) !== 'aborted') {
                setUi({ phase: 'error', message: t('read.error') + ' — ' + str((err && err.message) || err) });
              }
            });
            return function () { ctrl.abort(); };
          }, [sessionId, nonce]);

          // load + watch the selected state file (re-checked on every tick)
          React.useEffect(function () {
            if (!sessionId || !remote || found.length === 0) return undefined;
            var file = found[Math.min(sel, found.length - 1)];
            if (!file) return undefined;
            live.sessionId = sessionId;
            live.file = file;
            if (lastFileRef.current !== file) {
              lastFileRef.current = file;
              fpRef.current = null;
              readyRef.current = false;
            }
            var ctrl = new AbortController();
            ctrlRef.current = ctrl;
            statFile(remote, sessionId, file, ctrl.signal).then(function (st) {
              if (ctrl.signal.aborted) return;
              if (!st) {
                // the state file vanished: fall back to the empty screen
                fpRef.current = null;
                readyRef.current = false;
                setFound([]);
                setUi({ phase: 'empty' });
                return;
              }
              var fp = str(st.value && st.value.version) + ':' + str(st.value && st.value.bytes);
              if (fp === fpRef.current && readyRef.current) return; // unchanged
              fpRef.current = fp;
              if (!readyRef.current) setUi({ phase: 'loading' });
              return readWholeFile(remote, sessionId, file, ctrl.signal).then(function (text) {
                var parsed;
                try { parsed = JSON.parse(text); }
                catch (err) { throw new Error(t('parse.error')); }
                if (!parsed || parsed.kind !== 'docflow') throw new Error(t('state.kind'));
                readyRef.current = true;
                setUi({ phase: 'ready', data: parsed });
              });
            }).catch(function (err) {
              if (String(err && err.message) === 'aborted') return;
              readyRef.current = false;
              setUi({ phase: 'error', message: t('read.error') + ' — ' + str((err && err.message) || err) });
            });
            return function () {
              ctrl.abort();
              if (live.file === file) { live.file = null; live.sessionId = null; }
            };
          }, [sessionId, found, sel, nonce, tickv]);

          function doRefresh() {
            fpRef.current = null;
            readyRef.current = false;
            setNonce(function (n) { return n + 1; });
          }

          // ---- small render helpers (defensive against any state shape) ----
          function chip(label, cls) {
            return React.createElement('span', { class: 'dfp-chip ' + cls }, label);
          }
          function sectionHead(label) {
            return React.createElement('div', { class: 'dfp-sec' }, label);
          }
          function stageLabel(s) {
            return known(STAGE_NAMES, s) ? t('stage.' + s) : (s || '—');
          }
          function sourceOf(e) {
            if (str(e.source_kind) === 'external') return str(e.source_ref);
            var f = str(e.source_file);
            var l = e.source_line;
            if (l != null && l !== '' && !isNaN(Number(l))) f = f + ':' + Number(l);
            return f;
          }
          function consInfo(S) {
            var c = obj(S.consistency) || {};
            var cs = known(CONS_STATUS, str(c.status)) ? str(c.status) : 'n/a';
            var verdicts = obj(c.verdicts) || {};
            var vk = Object.keys(verdicts).sort();
            var conflicts = [];
            for (var i = 0; i < vk.length; i++) {
              var vd = obj(verdicts[vk[i]]);
              if (vd && str(vd.verdict) === 'conflict') conflicts.push({ key: vk[i], note: str(vd.note) });
            }
            var entries = obj(S.entries) || {};
            var u = 0;
            Object.keys(entries).forEach(function (k) { var e = obj(entries[k]); if (e && e.useful) u++; });
            return { cs: cs, conflicts: conflicts, done: vk.length, total: u * (u - 1) / 2 };
          }
          function verifyBanner(S) {
            var vst = str((obj(S.verification) || {}).status) || 'unverified';
            var ci = consInfo(S);
            if (ci.cs === 'conflict') {
              return chip(t('banner.conflict.a') + ci.conflicts.length + t('banner.conflict.b'), 'dfp-c-error');
            }
            if (vst === 'passed' && ci.cs === 'pending') return chip(t('banner.cons.pending'), 'dfp-c-warn');
            if (vst === 'passed' && (ci.cs === 'passed' || ci.cs === 'n/a')) return chip(t('banner.verified'), 'dfp-c-success');
            if ((vst === 'stale' || vst === 'unverified') && Object.keys(obj(S.entries) || {}).length > 0) {
              return chip(t('banner.notverified'), 'dfp-c-neutral');
            }
            return null;
          }
          function dot(cls, titleText) {
            return React.createElement('span', { class: 'dfp-dot ' + cls, title: titleText });
          }
          function dash() { return React.createElement('span', { class: 'dfp-dash' }, '–'); }

          // ---- sections ----
          function renderRail(S) {
            var stage = str(S.stage);
            var curIdx = STEPS.indexOf(stage);
            var recheck = stage === 'recheck';
            if (recheck) curIdx = 1;
            var kids = [];
            for (var i = 0; i < STEPS.length; i++) {
              var step = STEPS[i];
              var cls = 'dfp-step';
              var label = stageLabel(step);
              if (recheck && i === 1) { cls += ' dfp-step-warn'; label = stageLabel('recheck'); }
              else if (i === curIdx) cls += ' dfp-step-cur';
              else if (curIdx !== -1 && i < curIdx) cls += ' dfp-step-done';
              if (i > 0) kids.push(React.createElement('span', { key: 's' + i, class: 'dfp-sep' }, '→'));
              kids.push(React.createElement('span', { key: step, class: cls }, label));
            }
            return React.createElement('div', { class: 'dfp-rail' }, kids);
          }

          function gateRow(label, g) {
            var status = g && g.status != null ? str(g.status) : 'locked';
            if (!known(GATE_STATUS, status)) status = 'locked';
            var nAnswers = 0;
            if (g) {
              if (typeof g.answerCount === 'number') nAnswers = g.answerCount;
              else if (Array.isArray(g.answers)) nAnswers = g.answers.length;
            }
            return React.createElement('div', { class: 'dfp-row', key: label },
              React.createElement('span', { class: 'dfp-lbl' }, label),
              chip(status === 'locked' ? t('gate.locked') : t('gate.' + status), GATE_CHIP[status] || 'dfp-c-neutral'),
              g && g.reconfirm ? React.createElement('span', { class: 'dfp-warnbadge' }, t('gate.reconfirm')) : null,
              nAnswers > 0 ? React.createElement('span', { class: 'dfp-meta' }, nAnswers + ' ' + t('gate.answers')) : null);
          }

          function renderGates(S) {
            var gates = obj(S.gates) || {};
            return React.createElement('div', null,
              sectionHead(t('gates')),
              React.createElement('div', { class: 'dfp-box' },
                gateRow(t('gate.understanding'), obj(gates.understanding)),
                gateRow(t('gate.gaps'), obj(gates.gaps))));
          }

          function pillRow(label, ids, cls) {
            var kids = [React.createElement('span', { key: 'l', class: 'dfp-lbl' }, label)];
            for (var i = 0; i < ids.length; i++) {
              kids.push(React.createElement('span', { key: 'p' + i, class: 'dfp-pill ' + cls }, str(ids[i])));
            }
            return React.createElement('div', { class: 'dfp-row' }, kids);
          }

          function renderVerification(S) {
            var v = obj(S.verification) || {};
            var status = str(v.status) || 'unverified';
            if (!known(VER_STATUS, status)) status = 'unverified';
            var ci = consInfo(S);
            var overallOk = status === 'passed' && (ci.cs === 'passed' || ci.cs === 'n/a');
            var verifying = status === 'passed' && ci.cs === 'pending';
            var failed = arr(v.failed), unanchored = arr(v.unanchored), unattested = arr(v.unattested), suspect = arr(v.suspect);
            var externals = arr(v.externals);
            var consLabel = ci.cs === 'n/a' ? t('c.na') : t('c.' + ci.cs);
            var kids = [
              React.createElement('div', { key: 'top', class: 'dfp-row' },
                chip(status === 'passed' ? t('ver.passed') : t('ver.' + status), VER_CHIP[status] || 'dfp-c-neutral'),
                overallOk ? chip(t('status.verified'), 'dfp-c-success') : null,
                verifying ? chip(t('status.verifying'), 'dfp-c-warn') : null,
                str(v.lastRun) ? React.createElement('span', { class: 'dfp-meta' }, t('ver.last') + ' ' + fmtTime(v.lastRun)) : null),
              React.createElement('div', { key: 'cons', class: 'dfp-row' },
                React.createElement('span', { class: 'dfp-lbl' }, t('consistency')),
                chip(consLabel, CONS_CHIP[ci.cs] || 'dfp-c-neutral'),
                ci.total > 0 ? React.createElement('span', { class: 'dfp-meta' },
                  Math.min(ci.done, ci.total) + '/' + ci.total + ' ' + t('c.pairs')) : null),
              failed.length ? pillRow(t('v.failed'), failed, 'dfp-pill-error') : null,
              unanchored.length ? pillRow(t('v.unanchored'), unanchored, 'dfp-pill-warn') : null,
              unattested.length ? pillRow(t('v.unattested'), unattested, '') : null,
              suspect.length ? pillRow(t('v.suspect'), suspect, 'dfp-pill-warn') : null,
              externals.length ? pillRow(t('v.externals'), externals, '') : null];
            if (ci.conflicts.length) {
              var ck = [React.createElement('span', { key: 'l', class: 'dfp-lbl' }, t('c.conflicts'))];
              for (var q = 0; q < ci.conflicts.length; q++) {
                ck.push(React.createElement('span', {
                  key: 'cx' + q, class: 'dfp-pill dfp-pill-error', title: ci.conflicts[q].note,
                }, ci.conflicts[q].key));
              }
              kids.push(React.createElement('div', { key: 'cfr', class: 'dfp-row' }, ck));
            }
            return React.createElement('div', null,
              sectionHead(t('verification')),
              React.createElement('div', { class: 'dfp-box' }, kids));
          }

          function entryDetail(e) {
            var kids = [];
            kids.push(React.createElement('div', { key: 'c', class: 'dfp-k' }, t('e.content')));
            kids.push(React.createElement('div', { key: 'cv', class: 'dfp-v' }, str(e.content)));
            if (str(e.relevance)) {
              kids.push(React.createElement('div', { key: 'r', class: 'dfp-k' }, t('e.relevance')));
              kids.push(React.createElement('div', { key: 'rv', class: 'dfp-v' }, str(e.relevance)));
            }
            if (str(e.source_quote)) {
              kids.push(React.createElement('div', { key: 'q', class: 'dfp-k' }, t('e.quote')));
              kids.push(React.createElement('div', { key: 'qv', class: 'dfp-quote' }, str(e.source_quote)));
            }
            var vv = obj(e.verify);
            kids.push(React.createElement('div', { key: 'i', class: 'dfp-k' }, t('e.integrity')));
            kids.push(React.createElement('div', { key: 'iv', class: 'dfp-v' },
              vv ? str(vv.status) + ' — ' + str(vv.detail) + (str(vv.at) ? ' · ' + fmtTime(vv.at) : '') : t('e.notverified')));
            var at = obj(e.attest);
            kids.push(React.createElement('div', { key: 'tt', class: 'dfp-k' }, t('e.trust')));
            kids.push(React.createElement('div', { key: 'ttv', class: 'dfp-v' },
              at ? str(at.verdict) + (str(at.note) ? ' — ' + str(at.note) : '') + (str(at.at) ? ' · ' + fmtTime(at.at) : '') : t('e.notattested')));
            if (str(e.addedAt)) kids.push(React.createElement('div', { key: 'ad', class: 'dfp-k' }, t('e.added') + ' ' + fmtTime(e.addedAt)));
            return React.createElement('div', { class: 'dfp-detail' }, kids);
          }

          function renderEntry(id, e) {
            var src = sourceOf(e);
            var vv = obj(e.verify);
            var at = obj(e.attest);
            var vDot = !vv ? dash()
              : vv.status === 'ok' ? dot('dfp-dot-ok', str(vv.detail))
              : vv.status === 'failed' ? dot('dfp-dot-failed', str(vv.detail))
              : dot('dfp-dot-warn', str(vv.detail));
            var aDot = !at ? dash()
              : str(at.verdict) === 'ok' ? dot('dfp-dot-ok', str(at.verdict))
              : dot('dfp-dot-warn', str(at.verdict) + (str(at.note) ? ' — ' + str(at.note) : ''));
            var kids = [
              React.createElement('span', { key: 'id', class: 'dfp-id ' + (e.useful ? 'dfp-id-u' : 'dfp-id-n') }, id),
              React.createElement('span', { key: 'ti', class: 'dfp-etitle', title: str(e.title) }, str(e.title) || '—'),
              str(e.source_kind) === 'external' ? React.createElement('span', { key: 'ex', class: 'dfp-ext', title: t('entry.external') }, 'ext') : null,
              src ? React.createElement('span', { key: 'sr', class: 'dfp-src', title: src }, midTruncate(src, 36)) : null,
              vDot, aDot];
            return React.createElement('div', { key: id },
              React.createElement('div', {
                class: 'dfp-entry',
                onClick: function () { setOpenId(openId === id ? null : id); },
              }, kids),
              openId === id ? entryDetail(e) : null);
          }

          function renderEntries(S) {
            var entries = obj(S.entries) || {};
            var ids = Object.keys(entries);
            var usefulIds = [], otherIds = [];
            for (var i = 0; i < ids.length; i++) {
              var e = obj(entries[ids[i]]);
              if (!e) continue;
              if (e.useful) usefulIds.push(ids[i]); else otherIds.push(ids[i]);
            }
            function byNum(a, b) {
              var na = Number(str(a).slice(1)) || 0, nb = Number(str(b).slice(1)) || 0;
              return na - nb;
            }
            usefulIds.sort(byNum);
            otherIds.sort(byNum);
            var kids = [React.createElement('div', { key: 'head', class: 'dfp-sec' },
              t('entries') + ' · ' + t('entries.useful') + ' ' + usefulIds.length + ' / ' + t('entries.notuseful') + ' ' + otherIds.length)];
            if (ids.length === 0) {
              kids.push(React.createElement('div', { key: 'none', class: 'dfp-none' }, t('entries.none')));
              return React.createElement('div', null, kids);
            }
            if (usefulIds.length) {
              kids.push(React.createElement('div', { key: 'hu', class: 'dfp-k' }, t('entries.useful')));
              for (var u = 0; u < usefulIds.length; u++) kids.push(renderEntry(usefulIds[u], obj(entries[usefulIds[u]])));
            }
            if (otherIds.length) {
              kids.push(React.createElement('div', { key: 'hn', class: 'dfp-k' }, t('entries.notuseful')));
              for (var n = 0; n < otherIds.length; n++) kids.push(renderEntry(otherIds[n], obj(entries[otherIds[n]])));
            }
            return React.createElement('div', null, kids);
          }

          function renderPending(S) {
            var pend = arr(S.pendingDocs);
            if (pend.length === 0) return null;
            var kids = [React.createElement('div', { key: 'h', class: 'dfp-sec' }, t('pending.title'))];
            for (var i = 0; i < pend.length; i++) {
              kids.push(React.createElement('div', { key: i, class: 'dfp-v' }, React.createElement('span', { class: 'dfp-code' }, str(pend[i]))));
            }
            return React.createElement('div', { class: 'dfp-box dfp-pend' }, kids);
          }

          function renderPlan(S) {
            var plan = obj(S.plan);
            if (!plan || !plan.writtenAt) return null;
            return React.createElement('div', null,
              sectionHead(t('plan')),
              React.createElement('div', { class: 'dfp-box' },
                React.createElement('div', { class: 'dfp-row' },
                  chip(t('plan.written'), 'dfp-c-success'),
                  React.createElement('span', { class: 'dfp-code' }, str(plan.notes) || 'NOTES.md'),
                  React.createElement('span', { class: 'dfp-code' }, str(plan.plan) || 'PLAN.md'),
                  React.createElement('span', { class: 'dfp-meta' }, fmtTime(plan.writtenAt)))));
          }

          function projectLabel(p) {
            var idx = p.indexOf('/' + ROOT_STATE);
            if (idx === -1) return t('project.root');
            return p.slice(0, idx) || t('project.root');
          }

          // ---- render ----
          var S = ui.phase === 'ready' ? (obj(ui.data) || {}) : null;
          var stage = S ? str(S.stage) : '';

          return React.createElement('div', { class: 'dfp-root' },
            React.createElement('style', null, CSS),
            React.createElement('div', { class: 'dfp-bar' },
              React.createElement('span', { class: 'dfp-title' }, t('title')),
              found.length > 1 ? React.createElement('select', {
                class: 'dfp-sel', value: Math.min(sel, found.length - 1),
                onChange: function (ev) { setSel(+ev.target.value); setOpenId(null); },
              }, found.map(function (p, i) {
                return React.createElement('option', { key: i, value: i }, projectLabel(p));
              })) : null,
              React.createElement('button', {
                class: 'dfp-btn', disabled: ui.phase === 'loading', onClick: doRefresh,
              }, t('refresh')),
              S && str(S.updatedAt) ? React.createElement('span', { class: 'dfp-meta' },
                t('updated') + ' ' + fmtTime(S.updatedAt)) : null),

            ui.phase === 'loading' && !S ? React.createElement('div', { class: 'dfp-mid' },
              React.createElement('div', { class: 'dfp-spin' }), t('loading')) : null,

            ui.phase === 'empty' ? React.createElement('div', { class: 'dfp-empty' },
              React.createElement('b', null, t('empty.title')),
              React.createElement('span', null, t('empty.body')),
              React.createElement('span', null, t('empty.hint.a'),
                React.createElement('code', { class: 'dfp-code' }, 'docflow'), t('empty.hint.b'))) : null,

            ui.phase === 'error' ? React.createElement('div', { class: 'dfp-box dfp-err' },
              React.createElement('div', null, str(ui.message)),
              React.createElement('div', { class: 'dfp-row' },
                React.createElement('button', { class: 'dfp-btn', onClick: doRefresh }, t('refresh')))) : null,

            S ? React.createElement('div', null,
              React.createElement('div', { class: 'dfp-obj', title: str(S.objective) },
                str(S.objective) ? t('objective') + ': ' + str(S.objective) : null),
              React.createElement('div', { class: 'dfp-row' },
                chip(stageLabel(stage), STAGE_CHIP[stage] || 'dfp-c-neutral'),
                verifyBanner(S)),
              renderRail(S),
              renderGates(S),
              renderVerification(S),
              renderEntries(S),
              renderPending(S),
              renderPlan(S)) : null);
        }

        ctx.effect(function () {
          return ctx.locale.register(NS, COPY);
        }, 'docflow.locale');

        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            multiple: false,
            title: function () { return t('title'); },
            guide: [{
              id: 'docflow',
              order: 31,
              title: function () { return t('guide.title'); },
              description: function () { return t('guide.desc'); },
            }],
          });
        }, 'docflow.type');

        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register({
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              locale: NS,
              inject: function () { return {}; },
            }, DocflowBody);
          });
        }, 'docflow.body');

        // Auto-refresh: every 7 s wake the panel, which re-stats the selected
        // state file and reloads only when version/bytes actually changed.
        ctx.effect(function () {
          return ctx.timer.interval(function () {
            if (!live.sessionId || !live.file) return;
            bumpAll();
          }, POLL_MS);
        }, 'docflow.poll');
      };
      return exports;
    },
  });
})();
