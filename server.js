const https = require('https');
const http  = require('http');

// ── Orari fissi RFI fallback (14 dic 2025 – 13 giu 2026)
const ORARI_FISSI = [
  // ══ ORARI UFFICIALI PDF sfmtorino.it (14 dic 2025 – 13 giu 2026) ══
  // Dir CHIVASSO — ref = partenza Candiolo, PL = ref+2min
  {n:'26200',dir:'Chivasso',ref:'05:42'},{n:'26204',dir:'Chivasso',ref:'06:42'},
  {n:'26302',dir:'Chivasso',ref:'07:15'},{n:'26206',dir:'Chivasso',ref:'07:42'},
  {n:'26304',dir:'Chivasso',ref:'08:15'},{n:'26208',dir:'Chivasso',ref:'08:42'},
  {n:'26308',dir:'Chivasso',ref:'09:15'},{n:'26210',dir:'Chivasso',ref:'09:42'},
  {n:'26212',dir:'Chivasso',ref:'10:42'},{n:'26214',dir:'Chivasso',ref:'11:42'},
  {n:'26216',dir:'Chivasso',ref:'12:42'},{n:'26218',dir:'Chivasso',ref:'13:42'},
  {n:'26312',dir:'Chivasso',ref:'14:15'},{n:'26220',dir:'Chivasso',ref:'14:42'},
  {n:'26222',dir:'Chivasso',ref:'15:42'},{n:'26224',dir:'Chivasso',ref:'16:42'},
  {n:'26226',dir:'Chivasso',ref:'17:42'},{n:'26314',dir:'Chivasso',ref:'18:15'},
  {n:'26228',dir:'Chivasso',ref:'18:42'},{n:'26316',dir:'Chivasso',ref:'19:15'},
  {n:'26230',dir:'Chivasso',ref:'19:42'},{n:'26232',dir:'Chivasso',ref:'20:42'},
  {n:'26234',dir:'Chivasso',ref:'21:42'},
  // Dir PINEROLO — ref = passaggio Nichelino, PL = ref+2min
  {n:'26252',dir:'Pinerolo',ref:'06:03'},{n:'26320',dir:'Pinerolo',ref:'06:34'},
  {n:'26254',dir:'Pinerolo',ref:'07:09'},{n:'26322',dir:'Pinerolo',ref:'07:34'},
  {n:'26256',dir:'Pinerolo',ref:'08:09'},{n:'26324',dir:'Pinerolo',ref:'08:34'},
  {n:'26258',dir:'Pinerolo',ref:'09:09'},{n:'26260',dir:'Pinerolo',ref:'10:09'},
  {n:'26262',dir:'Pinerolo',ref:'11:09'},{n:'26264',dir:'Pinerolo',ref:'12:09'},
  {n:'26266',dir:'Pinerolo',ref:'13:09'},{n:'26330',dir:'Pinerolo',ref:'13:34'},
  {n:'26268',dir:'Pinerolo',ref:'14:09'},{n:'26270',dir:'Pinerolo',ref:'15:09'},
  {n:'26272',dir:'Pinerolo',ref:'16:09'},{n:'26274',dir:'Pinerolo',ref:'17:09'},
  {n:'26336',dir:'Pinerolo',ref:'17:34'},{n:'26276',dir:'Pinerolo',ref:'18:09'},
  {n:'26338',dir:'Pinerolo',ref:'18:34'},{n:'26278',dir:'Pinerolo',ref:'19:09'},
  {n:'26280',dir:'Pinerolo',ref:'20:09'},{n:'26282',dir:'Pinerolo',ref:'21:09'},
  {n:'26294',dir:'Pinerolo',ref:'22:09'},
];

// ── Cache in memoria
let cache = {
  orari: ORARI_FISSI,
  ritardi: {},
  fonte: 'RFI fissi',
  aggiornato: null,
  ritardiAggiornati: null,
};

// ── Helper: fetch con timeout e User-Agent
function fetchJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VinopoPL/1.0)',
        'Accept': 'application/json, text/plain, */*',
      }
    }, res => {
      // Segui redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const trimmed = data.trim();
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
          return reject(new Error('Non JSON response'));
        }
        try { resolve(JSON.parse(trimmed)); }
        catch(e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function addMin(hhmm, d) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + d;
  return String(Math.floor(t / 60) % 24).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

function tsOra() {
  // Timestamp corrente in formato ViaggiaTreno
  const now = new Date();
  return now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + 'T' +
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':00';
}

// ── Aggiorna ritardi (ogni 30s)
async function aggiornaRitardi() {
  const url = `https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/S04203/${encodeURIComponent(tsOra())}`;
  try {
    const data = await fetchJSON(url);
    const nuovi = {};
    let n = 0;
    (data || []).forEach(t => {
      if (t.numeroTreno != null && t.ritardo != null) {
        nuovi[String(t.numeroTreno)] = t.ritardo;
        n++;
      }
    });
    if (n > 0) {
      cache.ritardi = nuovi;
      cache.ritardiAggiornati = new Date().toISOString();
      console.log(`[${new Date().toISOString()}] Ritardi OK: ${n} treni`);
    }
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] Ritardi: ${err.message}`);
  }
}

// ── Aggiorna orari live (ogni ora)
// Usa partenze da Candiolo (S04203) per dir Chivasso
// e arrivi a Candiolo = partenze da Nichelino (S00612) per dir Pinerolo
async function aggiornaOrari() {
  const ts = tsOra();
  try {
    const [daCan, daNic] = await Promise.all([
      fetchJSON(`https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/S04203/${encodeURIComponent(ts)}`),
      fetchJSON(`https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/S00612/${encodeURIComponent(ts)}`),
    ]);

    const nuovi = [];

    (daCan || []).forEach(t => {
      if (!t.numeroTreno || !t.orarioPartenza) return;
      const num = String(t.numeroTreno);
      if (!num.startsWith('262') && !num.startsWith('263')) return;
      const h = Math.floor(t.orarioPartenza / 100);
      const m = t.orarioPartenza % 100;
      const ref = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
      nuovi.push({ n: num, dir: 'Chivasso', ref, oraPL: addMin(ref, 2) });
    });

    (daNic || []).forEach(t => {
      if (!t.numeroTreno || !t.orarioPartenza) return;
      const num = String(t.numeroTreno);
      if (!num.startsWith('262') && !num.startsWith('263')) return;
      const h = Math.floor(t.orarioPartenza / 100);
      const m = t.orarioPartenza % 100;
      const ref = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
      nuovi.push({ n: num, dir: 'Pinerolo', ref, oraPL: addMin(ref, 2) });
    });

    if (nuovi.length >= 10) {
      cache.orari = nuovi;
      cache.fonte = 'ViaggiaTreno live';
      cache.aggiornato = new Date().toISOString();
      console.log(`[${new Date().toISOString()}] Orari live OK: ${nuovi.length} treni`);
    } else {
      // Troppo pochi — mantieni orari fissi ma non sovrascrivere
      if (cache.fonte !== 'ViaggiaTreno live') {
        cache.fonte = 'RFI fissi (VT pochi dati: ' + nuovi.length + ')';
      }
      console.warn(`[${new Date().toISOString()}] Orari VT insufficienti (${nuovi.length}), uso fissi`);
    }
  } catch (err) {
    if (cache.fonte !== 'ViaggiaTreno live') {
      cache.fonte = 'RFI fissi';
    }
    console.warn(`[${new Date().toISOString()}] Orari VT: ${err.message}`);
  }
}

// ── Server HTTP
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.end('{}'); return; }

  if (req.url === '/orari') {
    res.end(JSON.stringify({
      orari: cache.orari,
      ritardi: cache.ritardi,
      fonte: cache.fonte,
      aggiornato: cache.aggiornato,
      ritardiAggiornati: cache.ritardiAggiornati,
      serverTime: new Date().toISOString(),
    }));
  } else if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) + 's' }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
}).listen(PORT, () => {
  console.log(`Server P.L. Vinovo — porta ${PORT}`);
  aggiornaOrari();
  aggiornaRitardi();
  setInterval(aggiornaOrari,   60 * 60 * 1000); // ogni ora
  setInterval(aggiornaRitardi, 20 * 1000);       // ogni 30s
});
