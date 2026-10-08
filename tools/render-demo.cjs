const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const html = path.join(__dirname, 'render-motion.html');
const out = path.join(root, 'public', 'demo.webm');
const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chrome = chromeCandidates.find(fs.existsSync);
if (!chrome) throw new Error('Chrome ou Edge não encontrado para renderizar a demonstração.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zamai-flow-render-'));
const fileUrl = `file:///${html.replace(/\\/g, '/')}`;
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--disable-background-networking', '--autoplay-policy=no-user-gesture-required',
  '--remote-allow-origins=*', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, fileUrl,
], { windowsHide: true, stdio: 'ignore' });

async function main() {
  let ws;
  try {
    const activePort = path.join(profile, 'DevToolsActivePort');
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      if (fs.existsSync(activePort)) port = fs.readFileSync(activePort, 'utf8').split(/\r?\n/)[0];
      else await sleep(100);
    }
    if (!port) throw new Error('O Chrome não iniciou a interface de renderização.');

    let targets;
    for (let i = 0; i < 50; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`);
        targets = await response.json();
        if (targets.some(item => item.type === 'page')) break;
      } catch {}
      await sleep(100);
    }
    const page = targets?.find(item => item.type === 'page');
    if (!page) throw new Error('A aba de renderização não foi encontrada.');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    let commandId = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const request = pending.get(message.id);
      if (request) { pending.delete(message.id); request.resolve(message); }
    });
    const evaluate = expression => new Promise((resolve, reject) => {
      const id = ++commandId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Tempo esgotado ao consultar a renderização.')); } }, 5000);
    });

    await evaluate('document.readyState');
    await sleep(15000);
    const result = await evaluate('document.querySelector("#payload").textContent');
    const encoded = result?.result?.result?.value;
    if (!encoded || encoded.length < 1000) {
      const state = await evaluate('document.documentElement.dataset.done || "renderizando"');
      throw new Error(`A captura não terminou (${state?.result?.result?.value || 'sem dados'}).`);
    }
    fs.writeFileSync(out, Buffer.from(encoded, 'base64'));
    console.log(`Vídeo salvo em ${out} (${fs.statSync(out).size} bytes).`);
  } finally {
    try { ws?.close(); } catch {}
    browser.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
