# Design Mode v2 — sintesi in italiano

Decisioni di Boss del 2026-10-08 integrate (§13). Solo piano, nessun codice modificato. Documento completo (inglese): `design-mode-v2.md`. Il brief indicava `plans/`, ma `plans/` è un symlink gitignorato verso il checkout principale: il piano sta in `docs/design/`.

## 1. Problema

- L'ispezione Overlay di Chrome è sempre attiva e si mangia ogni click: la pagina non è navigabile.
- Parte da qualsiasi tab terminale; il grab finisce nella riga dell'agente senza revisione, commento per pick o scelta dell'agente.
- Nessun ciclo di ritorno dopo la modifica dell'agente; serve un URL (Repo Settings) altrimenti `about:blank`.
- **Il banner "controllato da software di test automatico" è colpa nostra:** `browser.rs:104-110` lancia tramite `chromey` senza `disable_default_args()`, e chromey aggiunge `--enable-automation` e `--disable-extensions` (`chromey-2.58.2/src/browser.rs:1578-1608`). Su questo Mac c'è solo Edge 154, niente Google Chrome. **Aggiornamento (story 1593-987f, merge `2aabe9a9c`):** il lancio v1 non passa più `--enable-automation` né `--disable-extensions`; era un prerequisito per caricare l'estensione. Il lancio v1 usa ancora CDP.

## 2. Cosa abbiamo già deciso (non si ripropone)

Screencast CDP: scartato (rifare frame e input, jank, nessun frame con tab nascosta, story 002-993b). Child webview Tauri: scartato (tre motori, nessuno screenshot WebKit, vista nativa sopra l'HTML; ricontrollato nei sorgenti tauri 2.11.5, `add_child` richiede `unstable`). Port di un guest overlay: scartato. Iframe/proxy: non può ispezionare cross-origin.

## 3. Evidenze dall'analisi di un'implementazione esistente

- Browser = `<webview>` Electron per tab; lo screencast serve solo mobile/headless. Non portabile in Tauri.
- Pick: overlay iniettato nella pagina e armato solo durante il pick, un pick per arming, Esc/timeout 120 s. Il click non blocca la navigazione fuori dal pick.
- Sidebar: tray di annotazioni con commento, modifica/elimina; il menu Send è lo stesso delle note di review di Markdown.
- Senza URL: barra indirizzi, omnibox, scansione porte con attribuzione al worktree per cwd/command line e URL stampati nel PTY convalidati contro un listener vivo. Nessun parsing di `package.json`/vite.
- Reload: si affida all'HMR del dev server; nessun reload su agente idle trovato nel codice letto.
- Da copiare: arming per pick, attribuzione porte, un solo percorso di invio. Da non copiare: webview, strumenti di markup, tassonomia di intent.

## 4. Candidati e raccomandazione

| Opzione | Esito |
|---|---|
| **X-A Estensione MV3 (content script + side panel + native messaging, senza CDP)** | **Raccomandata**: pick anche in iframe cross-origin, nessun banner, nessuna porta di debug, funziona anche nel Chrome/Edge dell'utente |
| X-B Estensione solo UI + backend CDP | Due canali, resta il banner/porta; scartata salvo esito negativo dello spike |
| Plugin TUIC da solo | Non può strumentare una pagina del browser; i plugin servono per UI dentro TUIC |
| Child webview, screencast, iframe | Già scartati |

Plugin o estensione? **Estensione** per pagina e sidebar (devono stare accanto alla pagina); **modulo Rust `design_mode` ridotto** per il lato TUIC (lista agenti, invio con idle gate, trigger reload, scoperta dev server). Nessun plugin TUIC in v2.0.

Fatti verificati online: Chrome 137+ non onora più `--load-extension` (resta su Chromium/Chrome for Testing); `Extensions.loadUnpacked` richiede `--remote-debugging-pipe`; `chrome.sidePanel` esiste anche su Edge ("sidebar") con differenze. Non verificato: `--load-extension` e side panel su Edge 154 (spike S0).

## 5. Architettura

- Content script in MAIN world, `all_frames`, `document_start`, solo host loopback di default: overlay in Shadow DOM chiuso, `extract.js` esistente, sonda HMR (wrapper di `WebSocket`), screenshot con `captureVisibleTab` + crop.
- Side panel = sidebar: bottoni Pick / Multi-pick / Stop, card per pick (dati, commento, elimina), selettore agente, Send.
- Canale con TUIC: **native messaging** (deciso da Boss, Q2: nessuna porta, ID estensione fissato in `allowed_origins`, host che inoltra a `mcp.sock`, adattatore con framing a lunghezza, vedi §14). Alternativa di riserva: HTTP loopback + token (nuovo listener, nuovo confine di fiducia). TUIC oggi non ha listener TCP sempre attivo.

## 6. Ingresso e caso senza URL

Ingressi: icona dell'estensione (un click), comando **Open in Design Mode browser** a livello repo (palette/menu) e pulsante sulle tab URL. Eliminati: voce nel menu delle tab terminale, voce palette sul terminale attivo, badge `D`.

Senza URL, scelta: **scoperta dei dev server servita da TUIC e mostrata nel side panel, più la barra indirizzi del browser come base**. Ordine (Q7, deciso): URL esplicito in Repo Settings per primo, con accanto etichettato un URL PTY fresco su altra porta (Vite sposta 5173→5174); poi porte in ascolto su loopback attribuite per cwd/command line (deepest match) > URL stampato nel PTY convalidato > recenti > pulsante "Start dev server". Parsing di config scartato (indovina una porta diversa da quella reale).

## 7. Sidebar, commento, agente

Stessa regola agenti di Markdown (`reviewAgents`: stesso repo, primo come default), estratta in una funzione condivisa. Invio in coda con `enqueue_agent_command` (idle gate, deciso Q3): subito se idle, altrimenti al prossimo busy→idle. Cambio rispetto a v1: non più "incolla senza Invio", la sidebar è lo step di revisione.

## 8. Reload

TUIC calcola il busy→idle dopo l'invio e lo notifica all'estensione. Dopo la revisione Codex: nessun segnale basato su `enqueue`; si correla id comando → consegna → epoca turno → completamento confermato, ignorando idle a timer e `awaiting_input` di Codex pronto. Reload normale (non bypassCache) che con un form sporco non ricarica e mostra un avviso con pulsante **Reload** (deciso Q4); HMR non prova un aggiornamento riuscito. Coalescenza, toggle auto-reload, pulsante manuale.

## 9. Lancio, installazione, banner

Browser scelto dall'utente (Q9): predefinito una finestra Edge/Chrome con profilo proprio per repository, lanciata come processo normale; opzionale l'Edge/Chrome di tutti i giorni con l'estensione installata; niente Safari (non in v2.0 né pianificato: servirebbe app macOS firmata, sidebar in finestra separata, canale diverso). TUIC apre Edge o Chrome qualunque sia il browser di sistema. Lancio: niente `--remote-debugging-*`, niente `--enable-automation`. Estensione: "Load unpacked" una volta per profilo durante il pilota (deciso Q6), poi scheda store non in elenco (S7), da cartella materializzata da TUIC (chiave fissa ⇒ ID stabile). Manifest dell'host native messaging scritto da TUIC per il browser scelto.

## 10. PWA / mobile

Il browser si apre sempre sull'host; il client PWA vede "Design Mode gira sul computer host" e un pulsante per avviarlo. Nessuna promessa mobile.

## 11. Sicurezza

La pagina è input non fidato. Le pagine non parlano mai con TUIC; solo l'estensione. Sanitizzazione in Rust (`payload.rs`) prima di ogni testo verso l'agente; commento utente e evidenza della pagina in regioni separate. Content script solo su host loopback salvo permesso esplicito. Source map solo loopback (`source.rs`). Shell-out della scoperta solo con interi (pid, porta).

## 12. Slice e validazione

S0 spike (Edge 154: load-extension, sidePanel, NativeMessagingHosts in profilo custom, vita del service worker, pick in iframe cross-origin, captureVisibleTab, HMR); S1 estensione + pick + card; S2 host native messaging + installazione; S3 agent picker + invio; S4 scoperta dev server (fixture `lsof` registrate su questo Mac); S5 ciclo reload (macchina a stati con eventi finti); S6 rimozione ingresso terminale e backend CDP (solo dopo che S0 prova le source map senza CDP; serve permesso esplicito di Boss); S7 distribuzione store non in elenco dopo il pilota.

## 13. Decisioni (Boss, 2026-10-08)

**Decise da Boss:**

- Q2 Canale: native messaging (il browser avvia un piccolo programma TUIC che inoltra i messaggi; nessuna porta di rete).
- Q3 Invio: in coda con idle gate, come le note di review di Markdown (subito se l'agente è idle, altrimenti a fine turno).
- Q6 Installazione: "Load unpacked" una volta per profilo durante il pilota, poi scheda store non in elenco.
- Q8 Repo remoti/SSH: slice successiva, non in v2.0.
- Q9 Browser: sceglie l'utente. Predefinito: finestra Edge/Chrome con profilo proprio per repository. Opzione: l'Edge/Chrome di tutti i giorni con l'estensione. Niente Safari.

**Decise dal coordinatore:**

- Q1 + Q5: si costruisce l'estensione. Il codice CDP (`browser.rs`, parti CDP di `manager.rs`) resta finché lo spike S0 non prova le source map senza CDP; la rimozione in S6 richiede il permesso di Boss.
- Q4: con un form sporco niente reload, avviso con pulsante **Reload**.
- Q7: prima l'URL configurato; accanto, etichettato, un URL PTY fresco.

**Domande ancora aperte:** nessuna. Se S0 smentisce un'ipotesi (per esempio il comportamento di Edge 154), il piano torna a Boss.

## 14. Revisione Codex

Revisore: Codex (astra), sola lettura, HEAD e25adff0e. Verdetto: X-A con native messaging, **condizionato a uno S0 più forte**; non cancellare ancora il CDP. Rischio principale: reload della pagina sbagliata / perdita dati. Nessun disaccordo: ho accettato tutti i punti.

1. **Ranking rigido: d'accordo.** URL esplicito etichettato; URL PTY fresco e validato preferito alle porte nude se Vite incrementa; dedup; worktree e app monorepo distinti; Docker non prova l'identità del repo; includere listener wildcard/IPv6; `lsof` limitato e in cache con costo misurato su macOS; mai aprire in automatico un candidato ambiguo.
2. **MAIN da solo non basta: d'accordo.** Picker/bridge in ISOLATED world più minimi hint MAIN (CSP della pagina, API sostituibili, origini per `all_frames`). Verificato `manager.rs:481`: le source map oggi arrivano da `Debugger.scriptParsed` (CDP); senza CDP la scoperta è più debole → test in S0. Il nonce MAIN non è autenticazione.
3. **Native messaging: d'accordo.** Il bridge esistente non è riusabile così com'è (framing a riga, rifiuta argomenti: `tuic-bridge/src/main.rs:902,986`; verificato): serve un adattatore con framing a lunghezza e handshake esplicito dell'istanza.
4. **Install: d'accordo.** Unpacked per il pilota (una volta per profilo), poi store non in elenco.
5. **Euristica di reload sbagliata: d'accordo.** Correlare id comando → consegna reale → epoca del turno → completamento confermato; `awaiting_input` è sempre vero per Codex pronto (`pty.rs:8536-8542`, verificato); idle a timer è euristico; traffico HMR ≠ aggiornamento riuscito; reload normale che preserva i form sporchi.
6. Mancanze accettate: `captureVisibleTab` richiede `activeTab`/all_urls, race tab/documento, trasformazioni di coordinate dei frame, aggiornamenti dell'estensione, sostituzione delle source map.
