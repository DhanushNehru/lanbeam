(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const CHUNK = 16 * 1024; // 16KB data channel chunks
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  let ws = null;
  let pc = null;
  let dc = null;
  let role = null;
  let roomCode = null;
  let accepted = false;

  // sender state
  let files = [];            // File[]
  let sentSet = new Set();   // indexes already transferred
  let pumping = false;
  const sendRows = new Map(); // index -> {bar, meta}

  // receiver state
  const incoming = new Map(); // index -> { meta, chunks, received, row }
  const seenMeta = new Set();

  /* ---------------- helpers ---------------- */

  function show(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('#' + id).classList.remove('hidden');
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function setStatus(el, msg, cls) {
    el.textContent = msg;
    el.className = 'status' + (cls ? ' ' + cls : '');
  }

  /* ---------------- signaling ---------------- */

  function connect(onOpen) {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    ws = new WebSocket(url);
    ws.onopen = onOpen;
    ws.onmessage = (e) => onSignal(JSON.parse(e.data));
    ws.onclose = () => {
      setStatus(role === 'sender' ? $('#send-status') : $('#recv-status'),
        'Lost connection to the server. Refresh to try again.', 'warn');
    };
  }

  function onSignal(msg) {
    switch (msg.type) {
      case 'created':
        roomCode = msg.code;
        $('#room-code').textContent = roomCode;
        const link = location.origin + location.pathname + '?room=' + roomCode;
        $('#share-link').value = link;
        $('#send-code-card').classList.remove('hidden');
        try {
          if (window.QRCode) {
            $('#qr').innerHTML = '';
            new QRCode($('#qr'), { text: link, width: 112, height: 112 });
          } else {
            $('#qr').textContent = 'QR unavailable offline — share the link';
          }
        } catch { $('#qr').textContent = 'QR unavailable — share the link'; }
        break;

      case 'joined':
        roomCode = msg.code;
        setStatus($('#recv-status'), 'Connected. Waiting for sender…');
        break;

      case 'peer-joined':
        if (role === 'sender') {
          setStatus($('#send-status'), 'Receiver connected — establishing encrypted channel…', 'ok');
          startOffer();
        }
        break;

      case 'signal':
        handleRemoteSignal(msg.payload);
        break;

      case 'peer-left':
        closePeer('The other device disconnected.');
        break;

      case 'error':
        setStatus(role === 'sender' ? $('#send-status') : $('#recv-status'), msg.message, 'warn');
        break;
    }
  }

  /* ---------------- webrtc ---------------- */

  async function startOffer() {
    pc = new RTCPeerConnection(ICE);
    dc = pc.createDataChannel('lanbeam');
    wireDataChannel();
    pc.onicecandidate = (e) => {
      if (e.candidate) ws.send(JSON.stringify({ type: 'signal', payload: { ice: e.candidate } }));
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'signal', payload: { sdp: pc.localDescription } }));
  }

  async function handleRemoteSignal(p) {
    if (p.sdp) {
      if (role === 'receiver' && !pc) {
        pc = new RTCPeerConnection(ICE);
        pc.onicecandidate = (e) => {
          if (e.candidate) ws.send(JSON.stringify({ type: 'signal', payload: { ice: e.candidate } }));
        };
        pc.ondatachannel = (e) => { dc = e.channel; wireDataChannel(); };
        await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'signal', payload: { sdp: pc.localDescription } }));
      } else if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
      }
    } else if (p.ice && pc) {
      try { await pc.addIceCandidate(new RTCIceCandidate(p.ice)); } catch {}
    }
  }

  function wireDataChannel() {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      if (role === 'sender') {
        setStatus($('#send-status'), 'Encrypted channel open. Add files, then wait for the receiver to accept.', 'ok');
        $('#note-card').classList.remove('hidden');
        if (files.length) sendMeta();
      } else {
        setStatus($('#recv-status'), 'Encrypted channel open. Waiting for file list…', 'ok');
      }
    };
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') onControl(JSON.parse(e.data));
      else onChunk(e.data);
    };
    dc.onclose = () => closePeer('Connection closed.');
  }

  function closePeer(msg) {
    try { dc && dc.close(); } catch {}
    try { pc && pc.close(); } catch {}
    dc = pc = null;
    if (role === 'sender') setStatus($('#send-status'), msg, 'warn');
    else setStatus($('#recv-status'), msg, 'warn');
  }

  /* ---------------- sender ---------------- */

  function sendMeta() {
    if (!dc || dc.readyState !== 'open') return;
    dc.send(JSON.stringify({
      type: 'meta',
      files: files.map((f, i) => ({ index: i, name: f.name, size: f.size, mime: f.type || 'application/octet-stream' })),
    }));
  }

  function addFiles(list) {
    for (const f of list) {
      const i = files.length;
      files.push(f);
      renderSendRow(i, f);
    }
    if (dc && dc.readyState === 'open') {
      sendMeta();
      if (accepted) pumpQueue();
    } else if (!roomCode) {
      toast('Files queued — share your room code once it appears.');
    }
  }

  function renderSendRow(i, f) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="frow"><div><div class="fname"></div><div class="fmeta"></div></div></div>
      <div class="progress"><div></div></div>`;
    li.querySelector('.fname').textContent = f.name;
    li.querySelector('.fmeta').textContent = fmtBytes(f.size);
    $('#send-list').appendChild(li);
    sendRows.set(i, { bar: li.querySelector('.progress > div'), meta: li.querySelector('.fmeta') });
  }

  function onControl(msg) {
    if (role === 'sender') {
      if (msg.type === 'accept') {
        accepted = true;
        setStatus($('#send-status'), 'Receiver accepted — sending…', 'ok');
        pumpQueue();
      } else if (msg.type === 'decline') {
        setStatus($('#send-status'), 'Receiver declined the transfer.', 'warn');
      } else if (msg.type === 'note-ack') {
        toast('Note delivered ✓');
      }
    } else {
      if (msg.type === 'meta') onMeta(msg.files);
      else if (msg.type === 'file-start') onFileStart(msg);
      else if (msg.type === 'file-end') onFileEnd(msg.index);
      else if (msg.type === 'done') setStatus($('#recv-status'), 'All files received. 🎉', 'ok');
      else if (msg.type === 'note') onNote(msg.text);
    }
  }

  async function pumpQueue() {
    if (pumping || !dc || dc.readyState !== 'open') return;
    pumping = true;
    for (let i = 0; i < files.length; i++) {
      if (sentSet.has(i)) continue;
      await sendFile(i);
      sentSet.add(i);
    }
    dc.send(JSON.stringify({ type: 'done' }));
    setStatus($('#send-status'), 'All files sent. 🎉', 'ok');
    pumping = false;
  }

  async function sendFile(i) {
    const f = files[i];
    const row = sendRows.get(i);
    dc.send(JSON.stringify({ type: 'file-start', index: i, name: f.name, size: f.size, mime: f.type || 'application/octet-stream' }));
    let offset = 0;
    const t0 = performance.now();
    while (offset < f.size) {
      while (dc.bufferedAmount > 1024 * 1024) await new Promise((r) => setTimeout(r, 40));
      const buf = await f.slice(offset, offset + CHUNK).arrayBuffer();
      dc.send(buf);
      offset += buf.byteLength;
      const pct = Math.round((offset / f.size) * 100);
      if (row) {
        row.bar.style.width = pct + '%';
        const speed = offset / ((performance.now() - t0) / 1000);
        row.meta.textContent = `${fmtBytes(f.size)} · ${pct}% · ${fmtBytes(speed)}/s`;
      }
    }
    dc.send(JSON.stringify({ type: 'file-end', index: i }));
  }

  /* ---------------- receiver ---------------- */

  function onMeta(fileList) {
    let fresh = 0;
    for (const meta of fileList) {
      if (seenMeta.has(meta.index)) continue;
      seenMeta.add(meta.index);
      fresh++;
      renderRecvRow(meta);
    }
    if (!fresh) return;
    setStatus($('#recv-status'), `${seenMeta.size} file(s) offered. Review and accept to start.`, 'ok');
    if (!$('#btn-accept')) {
      const btn = document.createElement('button');
      btn.id = 'btn-accept';
      btn.className = 'btn primary small';
      btn.textContent = '✓ Accept transfer';
      btn.style.marginTop = '12px';
      btn.onclick = () => {
        dc.send(JSON.stringify({ type: 'accept' }));
        btn.remove();
        const d = $('#btn-decline'); d && d.remove();
        setStatus($('#recv-status'), 'Receiving…', 'ok');
      };
      const dec = document.createElement('button');
      dec.id = 'btn-decline';
      dec.className = 'btn small ghost';
      dec.textContent = 'Decline';
      dec.style.marginTop = '12px';
      dec.style.marginLeft = '8px';
      dec.onclick = () => {
        dc.send(JSON.stringify({ type: 'decline' }));
        btn.remove(); dec.remove();
        setStatus($('#recv-status'), 'Transfer declined.', 'warn');
      };
      $('#recv-status').after(btn, dec);
    }
  }

  function renderRecvRow(meta) {
    const li = document.createElement('li');
    li.id = 'recv-' + meta.index;
    li.innerHTML = `<div class="fname"></div><div class="fmeta"></div><div class="progress"><div></div></div>`;
    li.querySelector('.fname').textContent = meta.name;
    li.querySelector('.fmeta').textContent = fmtBytes(meta.size);
    $('#recv-list').appendChild(li);
    incoming.set(meta.index, {
      meta, chunks: [], received: 0,
      bar: li.querySelector('.progress > div'),
      metaEl: li.querySelector('.fmeta'),
      li,
    });
  }

  function onFileStart(msg) {
    if (!incoming.has(msg.index)) {
      renderRecvRow({ index: msg.index, name: msg.name, size: msg.size });
      seenMeta.add(msg.index);
    }
  }

  function onChunk(buf) {
    // attribute to the most recent in-progress file
    for (const [, inc] of incoming) {
      if (inc.received < inc.meta.size) {
        inc.chunks.push(buf);
        inc.received += buf.byteLength;
        const pct = Math.min(100, Math.round((inc.received / inc.meta.size) * 100));
        inc.bar.style.width = pct + '%';
        inc.metaEl.textContent = `${fmtBytes(inc.meta.size)} · ${pct}%`;
        return;
      }
    }
  }

  function onFileEnd(index) {
    const inc = incoming.get(index);
    if (!inc) return;
    const blob = new Blob(inc.chunks, { type: inc.meta.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    inc.bar.style.width = '100%';
    inc.metaEl.textContent = fmtBytes(inc.meta.size) + ' · complete';
    const a = document.createElement('a');
    a.href = url;
    a.download = inc.meta.name;
    a.className = 'dl';
    a.textContent = '⬇ Download ' + inc.meta.name;
    inc.li.appendChild(a);
    inc.chunks = []; // free memory
  }

  function onNote(text) {
    const div = document.createElement('div');
    div.className = 'note';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = 'Note from sender';
    const body = document.createElement('div');
    body.textContent = text;
    div.append(who, body);
    $('#recv-notes').appendChild(div);
    dc.send(JSON.stringify({ type: 'note-ack' }));
  }

  /* ---------------- ui wiring ---------------- */

  $('#btn-send').onclick = () => {
    role = 'sender';
    show('view-send');
    setStatus($('#send-status'), 'Creating room…');
    connect(() => ws.send(JSON.stringify({ type: 'create' })));
  };

  $('#btn-receive').onclick = () => {
    role = 'receiver';
    show('view-receive');
    const params = new URLSearchParams(location.search);
    if (params.get('room')) $('#join-code').value = params.get('room').toUpperCase();
  };

  document.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => {
    try { ws && ws.close(); } catch {}
    try { dc && dc.close(); } catch {}
    try { pc && pc.close(); } catch {}
    ws = dc = pc = null;
    location.search = '';
    location.hash = '';
    show('view-home');
  }));

  $('#btn-join').onclick = () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length !== 6) { toast('Enter the 6-character code'); return; }
    role = 'receiver';
    setStatus($('#recv-status'), 'Connecting…');
    connect(() => ws.send(JSON.stringify({ type: 'join', code })));
  };
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });

  const dz = $('#dropzone');
  const fi = $('#file-input');
  dz.onclick = (e) => { if (e.target !== fi) fi.click(); };
  fi.onchange = () => { addFiles(fi.files); fi.value = ''; };
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  $('#btn-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#share-link').value); toast('Link copied ✓'); }
    catch { $('#share-link').select(); toast('Copy the link manually'); }
  };

  $('#btn-note').onclick = () => {
    const v = $('#note-input').value.trim();
    if (!v || !dc || dc.readyState !== 'open') return;
    dc.send(JSON.stringify({ type: 'note', text: v }));
    $('#note-input').value = '';
  };
})();
