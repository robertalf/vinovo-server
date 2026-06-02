const https = require('https');
const http  = require('http');

// ── Orari fissi RFI come fallback (aggiornati al 14 dic 2025)
const ORARI_FISSI = {
  feriale: [
    // Dir. CHIVASSO — ref. Candiolo, PL = ref+2min
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
    // Dir. PINEROLO — ref. Nichelino, PL = ref+2min
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
  ]
};

// ── Stato in memoria
let cache = {
  orari:    ORARI_FISSI,        // orari correnti (fissi o aggiornati da VT)
  ritardi:  {},                  // {numeroTreno: minutiRitardo}
  fonteOrari: 'RFI fissi',
  ultimoAggiornamento: null,
  ultimoAggiornamentoRitardi: null,
};

// ── Helper: richiesta HTTP/HTTPS con timeout
function fetchJSON(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Helper: aggiunge minuti a HH:MM
function addMin(hhmm, d) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + d;
  return String(Math.floor(t / 60) % 24).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

// ── Aggiorna ritardi da ViaggiaTreno (stazione Candiolo = S04203)
async function aggiornaRitardi() {
  const now = new Date();
  const ts = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + 'T' +
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':00';

  const url = `https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/S04203/${encodeURIComponent(ts)}`;
  try {
    const data = await fetchJSON(url);
    const nuoviRitardi = {};
    let trovati = 0;
    (data || []).forEach(t => {
      if (t.numeroTreno != null && t.ritardo != null) {
        nuoviRitardi[String(t.numeroTreno)] = t.ritardo;
        trovati++;
      }
    });
    if (trovati > 0) {
      cache.ritardi = nuoviRitardi;
      cache.ultimoAggiornamentoRitardi = new Date().toISOString();
      console.log(`[${new Date().toISOString()}] Ritardi aggiornati: ${trovati} treni`);
    }
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] Ritardi non disponibili: ${err.message}`);
  }
}

// ── Aggiorna orari live da ViaggiaTreno
// Interroga le partenze di oggi da Candiolo e Nichelino
// e ricostruisce gli orari al PL (+2 min dalla stazione)
async function aggiornaOrari() {
  const now = new Date();
  // Interroga partenze dalle 04:00 di oggi
  const ts = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + 'T04:00:00';

  try {
    // Partenze da Candiolo (dir Chivasso) e da Nichelino (dir Pinerolo)
    const [candiolo, nichelino] = await Promise.all([
      fetchJSON(`https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/S04203/${encodeURIComponent(ts)}`),
      fetchJSON(`https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/S00219/${encodeURIComponent(ts)}`),
    ]);

    const nuoviOrari = [];
    let trovati = 0;

    // Processa partenze da Candiolo → dir Chivasso
    (candiolo || []).forEach(t => {
      if (!t.numeroTreno || !t.orarioPartenza) return;
      const h = Math.floor(t.orarioPartenza / 100);
      const m = t.orarioPartenza % 100;
      const ref = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      nuoviOrari.push({ n: String(t.numeroTreno), dir: 'Chivasso', ref, oraPL: addMin(ref, 2) });
      trovati++;
    });

    // Processa partenze da Nichelino → dir Pinerolo
    (nichelino || []).forEach(t => {
      if (!t.numeroTreno || !t.orarioPartenza) return;
      // Filtra solo treni SFM2 (numeri 262xx e 263xx)
      const num = String(t.numeroTreno);
      if (!num.startsWith('262') && !num.startsWith('263')) return;
      const h = Math.floor(t.orarioPartenza / 100);
      const m = t.orarioPartenza % 100;
      const ref = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      nuoviOrari.push({ n: num, dir: 'Pinerolo', ref, oraPL: addMin(ref, 2) });
      trovati++;
    });

    if (trovati >= 10) {
      // Abbastanza treni trovati — usa orari live
      cache.orari = { feriale: nuoviOrari };
      cache.fonteOrari = 'ViaggiaTreno live';
      cache.ultimoAggiornamento = new Date().toISOString();
      console.log(`[${new Date().toISOString()}] Orari live aggiornati: ${trovati} treni`);
    } else {
      // Troppo pochi — mantieni orari fissi
      cache.fonteOrari = 'RFI fissi (VT insufficiente)';
      console.warn(`[${new Date().toISOString()}] VT restituisce troppo pochi treni (${trovati}), mantengo fissi`);
    }
  } catch (err) {
    cache.fonteOrari = 'RFI fissi (VT non disponibile)';
    console.warn(`[${new Date().toISOString()}] Orari VT non disponibili: ${err.message}`);
  }
}

// ── Server HTTP
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  // CORS — permette all'app su GitHub Pages di chiamare questo server
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/orari') {
    // Restituisce orari + ritardi + metadata
    res.end(JSON.stringify({
      orari: cache.orari.feriale,
      ritardi: cache.ritardi,
      fonte: cache.fonteOrari,
      aggiornatoAlle: cache.ultimoAggiornamento,
      ritardiAggiornatoAlle: cache.ultimoAggiornamentoRitardi,
    }));
  } else if (req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`Server P.L. Vinovo avviato su porta ${PORT}`);
  // Primo aggiornamento immediato
  aggiornaOrari();
  aggiornaRitardi();
  // Aggiorna orari ogni ora
  setInterval(aggiornaOrari, 60 * 60 * 1000);
  // Aggiorna ritardi ogni 30 secondi
  setInterval(aggiornaRitardi, 30 * 1000);
});
