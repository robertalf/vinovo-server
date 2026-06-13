const https = require('https');
const http  = require('http');

// ── Orari fissi RFI fallback (14 dic 2025 – 13 giu 2026)
const ORARI_FISSI = [
  {n:'26200',dir:'Chivasso',ref:'05:42'},
  {n:'26204',dir:'Chivasso',ref:'06:42'},
  {n:'26302',dir:'Chivasso',ref:'07:15'},
  {n:'26206',dir:'Chivasso',ref:'07:42'},
  {n:'26304',dir:'Chivasso',ref:'08:15'},
  {n:'26208',dir:'Chivasso',ref:'08:42'},
  {n:'26308',dir:'Chivasso',ref:'09:15'},
  {n:'26210',dir:'Chivasso',ref:'09:42'},
  {n:'26212',dir:'Chivasso',ref:'10:42'},
  {n:'26214',dir:'Chivasso',ref:'11:42'},
  {n:'26216',dir:'Chivasso',ref:'12:42'},
  {n:'26218',dir:'Chivasso',ref:'13:42'},
  {n:'26312',dir:'Chivasso',ref:'14:15'},
  {n:'26220',dir:'Chivasso',ref:'14:42'},
  {n:'26222',dir:'Chivasso',ref:'15:42'},
  {n:'26224',dir:'Chivasso',ref:'16:42'},
  {n:'26226',dir:'Chivasso',ref:'17:42'},
  {n:'26314',dir:'Chivasso',ref:'18:15'},
  {n:'26228',dir:'Chivasso',ref:'18:42'},
  {n:'26316',dir:'Chivasso',ref:'19:15'},
  {n:'26230',dir:'Chivasso',ref:'19:42'},
  {n:'26232',dir:'Chivasso',ref:'20:42'},
  {n:'26234',dir:'Chivasso',ref:'21:42'},
  {n:'26252',dir:'Pinerolo',ref:'06:04'},
  {n:'26320',dir:'Pinerolo',ref:'06:39'},
  {n:'26254',dir:'Pinerolo',ref:'07:10'},
  {n:'26322',dir:'Pinerolo',ref:'07:39'},
  {n:'26256',dir:'Pinerolo',ref:'08:10'},
  {n:'26324',dir:'Pinerolo',ref:'08:39'},
  {n:'26258',dir:'Pinerolo',ref:'09:10'},
  {n:'26260',dir:'Pinerolo',ref:'10:10'},
  {n:'26262',dir:'Pinerolo',ref:'11:10'},
  {n:'26264',dir:'Pinerolo',ref:'12:10'},
  {n:'26266',dir:'Pinerolo',ref:'13:10'},
  {n:'26330',dir:'Pinerolo',ref:'13:39'},
  {n:'26268',dir:'Pinerolo',ref:'14:10'},
  {n:'26270',dir:'Pinerolo',ref:'15:10'},
  {n:'26272',dir:'Pinerolo',ref:'16:10'},
  {n:'26274',dir:'Pinerolo',ref:'17:10'},
  {n:'26336',dir:'Pinerolo',ref:'17:39'},
  {n:'26276',dir:'Pinerolo',ref:'18:10'},
  {n:'26338',dir:'Pinerolo',ref:'18:39'},
  {n:'26278',dir:'Pinerolo',ref:'19:10'},
  {n:'26280',dir:'Pinerolo',ref:'20:10'},
  {n:'26282',dir:'Pinerolo',ref:'21:10'},
  {n:'26294',dir:'Pinerolo',ref:'22:10'},
];

// ── Cache in memoria
let cache = {
  orari: ORARI_FISSI,
  ritardi: {},
  fonte: 'RFI fissi',
  aggiornato: null,
  ritardiAggiornati: null,
};

// ── Helper: fetch con timeout e headers browser reale
function fetchJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.viaggiatreno.it/',
        'Origin': 'https://www.viaggiatreno.it',
        'Connection': 'keep-alive',
      }
    }, res => {
      // Segui redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      // Gestisci gzip
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createGunzip());
      }
      let data = '';
      stream.on('data', chunk => data += chunk);
      stream.on('end', () => {
        const trimmed = data.trim();
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
          return reject(new Error('Non JSON: ' + trimmed.slice(0, 80)));
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
  // Interroga più stazioni per catturare tutti i treni SFM2
  // S04203 = Candiolo (dir Chivasso)
  // S00612 = Nichelino (dir Pinerolo)
  // S00219 = Torino Porta Susa (cattura tutti i treni in transito)
  const stazioni = ['S04203', 'S00612', 'S00219'];
  const ts = tsOra();
  const nuovi = {};
  let totale = 0;

  for (const staz of stazioni) {
    try {
      const url = `https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/${staz}/${encodeURIComponent(ts)}`;
      const data = await fetchJSON(url);
      (data || []).forEach(t => {
        if (t.numeroTreno != null && t.ritardo != null) {
          // Prendi il ritardo maggiore se lo stesso treno appare in più stazioni
          const num = String(t.numeroTreno);
          if (!nuovi[num] || t.ritardo > nuovi[num]) {
            nuovi[num] = t.ritardo;
            totale++;
          }
        }
      });
    } catch (err) {
      console.warn(`[${new Date().toISOString()}] Ritardi stazione ${staz}: ${err.message}`);
    }
  }

  if (Object.keys(nuovi).length > 0) {
    cache.ritardi = nuovi;
    cache.ritardiAggiornati = new Date().toISOString();
    console.log(`[${new Date().toISOString()}] Ritardi OK: ${Object.keys(nuovi).length} treni da ${stazioni.length} stazioni`);
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
