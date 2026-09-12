// Poll-sweep agent — a spike instrument, not a product.
//
// Same 8-hex-length-prefix protocol as ExtendBlueNode's jsx/agent.jsx, whose
// socket handling this reuses, plus two things that exist only to be measured:
//
//   op "cfg"  { pollMs, ui }  reconfigure the scheduleTask interval and whether
//                             the panel redraws its status on every request,
//                             without restarting the listener
//   op "stats"                request count, so the sweep can prove the agent
//                             actually served what the client thinks it did
//
// Listens on 7880 so it can coexist with the real EBN agent on 7879.
// Run via File > Scripts > Run Script File...  (floating palette, no install)

#target aftereffects

(function (thisObj) {
    var PORT = 7880;
    var state = {
        srv: null, taskId: null, pollMs: 60, ui: true,
        requests: 0, lastOk: null
    };
    var ui = {};

    // ---------- protocol (lifted from jsx/agent.jsx) ----------

    function pad8(n) {
        var s = n.toString(16);
        while (s.length < 8) s = '0' + s;
        return s;
    }

    function readN(conn, n) {
        var got = '', safety = 0;
        while (got.length < n && conn.connected && safety < 10000) {
            var chunk = conn.read(n - got.length);
            if (chunk === null || chunk === '') { if (conn.eof) break; }
            else { got += chunk; }
            safety++;
        }
        return got;
    }

    function writeJson(conn, s) { conn.write(pad8(s.length) + s); }

    // split/join rather than regex literals: a lone backslash inside a
    // regex literal is an unterminated-regex parse error, and this file is
    // rewritten by tooling often enough that the safer idiom earns its lines.
    function esc(v) {
        var s = String(v);
        s = s.split('\\').join('\\\\');
        s = s.split('"').join("'");
        s = s.split('\r').join(' ');
        s = s.split('\n').join(' ');
        return s;
    }

    function runScript(script) {
        try {
            eval(String(script));
            return '{"ok":true}';
        } catch (err) {
            return '{"ok":false,"message":"' + esc(err && (err.message || err)) +
                   '","line":' + Number(err && err.line || 0) + '}';
        }
    }

    function handle(conn) {
        try {
            var header = readN(conn, 8);
            if (header.length < 8) return;
            var len = parseInt(header, 16);
            if (isNaN(len) || len < 0 || len > 16 * 1024 * 1024) {
                writeJson(conn, '{"ok":false,"message":"bad length header"}');
                return;
            }
            var req = null;
            try { req = JSON.parse(readN(conn, len)); }
            catch (e) { writeJson(conn, '{"ok":false,"message":"bad JSON"}'); return; }

            var out;
            if (req.op === 'ping') {
                out = '{"ok":true,"pollMs":' + state.pollMs + ',"ui":' + state.ui + '}';
            } else if (req.op === 'run') {
                out = runScript(req.script || '');
            } else if (req.op === 'cfg') {
                applyCfg(req.pollMs, req.ui);
                out = '{"ok":true,"pollMs":' + state.pollMs + ',"ui":' + state.ui + '}';
            } else if (req.op === 'stats') {
                out = '{"ok":true,"requests":' + state.requests +
                      ',"pollMs":' + state.pollMs + ',"ui":' + state.ui + '}';
            } else {
                out = '{"ok":false,"message":"unknown op"}';
            }
            writeJson(conn, out);
        } catch (e) {
            try { writeJson(conn, '{"ok":false,"message":"' + esc(e) + '"}'); } catch (_) {}
        } finally {
            state.requests++;
            // The thing under test: jsx/agent.jsx refreshes its panel here, on
            // every single request. That is a ScriptUI redraw inside the
            // measured round trip.
            if (state.ui) refresh();
        }
    }

    // ---------- listener ----------

    function tick() {
        if (!state.srv) return;
        try {
            var conn = state.srv.poll();
            if (conn) { handle(conn); try { conn.close(); } catch (_) {} }
        } catch (e) { /* keep ticking */ }
    }
    $.global.NTL_POLL_TICK = tick;

    function reschedule() {
        if (state.taskId !== null) {
            try { app.cancelTask(state.taskId); } catch (_) {}
            state.taskId = null;
        }
        state.taskId = app.scheduleTask('NTL_POLL_TICK()', state.pollMs, true);
    }

    function applyCfg(pollMs, uiOn) {
        if (typeof uiOn === 'boolean') state.ui = uiOn;
        if (pollMs && pollMs > 0) {
            state.pollMs = pollMs;
            reschedule();     // cancel + reschedule; the socket keeps listening
        }
        refresh();
    }

    function start() {
        if (state.srv) return;
        state.srv = new Socket();
        if (!state.srv.listen(PORT, 'BINARY')) {
            state.srv = null;
            ui.status.text = 'Port ' + PORT + ' in use';
            return;
        }
        reschedule();
        refresh();
    }

    function stop() {
        if (state.taskId !== null) { try { app.cancelTask(state.taskId); } catch (_) {} state.taskId = null; }
        if (state.srv) { try { state.srv.close(); } catch (_) {} state.srv = null; }
        ui.status.text = 'Stopped';
    }

    function refresh() {
        if (!ui.status) return;
        ui.status.text = (state.srv ? 'Listening ' + PORT : 'Stopped') +
            '  ·  poll ' + state.pollMs + 'ms  ·  ui ' + (state.ui ? 'on' : 'off') +
            '  ·  ' + state.requests + ' req';
    }

    // ---------- UI ----------

    function build(win) {
        win.orientation = 'column';
        win.alignChildren = ['fill', 'top'];
        win.spacing = 6;
        win.margins = 10;

        ui.status = win.add('statictext', undefined, 'Starting...');
        var row = win.add('group');
        row.add('button', undefined, 'Start').onClick = start;
        row.add('button', undefined, 'Stop').onClick = stop;

        win.add('statictext', undefined, 'Spike instrument. Port 7880.');
        return win;
    }

    var win = (thisObj instanceof Panel)
        ? build(thisObj)
        : build(new Window('palette', 'NTL Poll Sweep', undefined, { resizeable: true }));

    if (win instanceof Window) { win.center(); win.show(); }
    else { win.layout.layout(true); }

    start();
})(this);
