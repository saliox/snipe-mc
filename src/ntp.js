// Client SNTP minimal (RFC 4330) pour mesurer le décalage entre l'horloge
// locale et une horloge de référence. Objectif : tirer les requêtes de snipe
// au bon moment même si l'horloge Windows dérive de plusieurs centaines de ms.
import dgram from 'node:dgram';

const NTP_EPOCH_OFFSET = 2208988800; // secondes entre 1900 et 1970

function readTimestamp(buf, offset) {
  // Paquet UDP tronqué/malformé (mauvais serveur, réseau capricieux, ...) : on
  // refuse de lire hors-borne plutôt que de laisser readUInt32BE lever un
  // RangeError non rattrapé (ça planterait tout le process, voir appelant).
  if (!Buffer.isBuffer(buf) || buf.length < offset + 8) {
    throw new Error(`Paquet NTP trop court (${buf ? buf.length : 0} octets, offset ${offset})`);
  }
  const seconds = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  return (seconds - NTP_EPOCH_OFFSET) * 1000 + (fraction * 1000) / 0x100000000;
}

// Renvoie { offset, rtt } en ms. offset > 0 signifie que l'horloge locale
// est en retard sur le serveur.
export function ntpQuery(server = 'time.google.com', port = 123, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b; // LI=0, VN=3, Mode=3 (client)

    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      err ? reject(err) : resolve(val);
    };

    const timer = setTimeout(() => finish(new Error(`Timeout NTP (${server})`)), timeout);

    socket.on('error', (e) => finish(e));
    socket.on('message', (msg) => {
      // Try/catch : un datagramme malformé (paquet tronqué, réponse d'un
      // service tiers, ...) ne doit jamais faire planter tout le process — on
      // le journalise et on l'ignore ; le timeout global prend le relais si
      // aucun paquet valide n'arrive jamais.
      try {
        const T4 = Date.now();
        const T1 = t1;
        const T2 = readTimestamp(msg, 32); // receive timestamp du serveur
        const T3 = readTimestamp(msg, 40); // transmit timestamp du serveur
        const offset = ((T2 - T1) + (T3 - T4)) / 2;
        const rtt = (T4 - T1) - (T3 - T2);
        finish(null, { offset, rtt, server });
      } catch (e) {
        console.error(`[ntp] paquet ignoré (${server}):`, e.message);
      }
    });

    let t1;
    // connect() lie le socket au pair interrogé : seuls les datagrammes en
    // provenance de ce host:port précis sont livrés à 'message' (au lieu de
    // faire confiance au tout premier paquet UDP reçu, usurpable par n'importe
    // quelle source sur le réseau).
    socket.connect(port, server, (connectErr) => {
      if (connectErr) return finish(connectErr);
      socket.send(packet, (err) => {
        if (err) return finish(err);
        t1 = Date.now();
      });
    });
  });
}

// Interroge plusieurs serveurs et garde la mesure au plus faible RTT (la plus fiable).
export async function bestOffset(servers = ['time.google.com', 'time.cloudflare.com', 'pool.ntp.org']) {
  const results = [];
  for (const s of servers) {
    try {
      results.push(await ntpQuery(s));
    } catch { /* on ignore le serveur injoignable */ }
  }
  if (!results.length) throw new Error('Aucun serveur NTP joignable');
  results.sort((a, b) => a.rtt - b.rtt);
  return results[0];
}
