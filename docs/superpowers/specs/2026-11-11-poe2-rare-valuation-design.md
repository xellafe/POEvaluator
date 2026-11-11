# POEvaluator — Valutatore di oggetti rari per Path of Exile 2 — Design

Data: 2026-11-11 · Progetto open source pubblico su GitHub.

## 1. Intento

Gli strumenti di price check esistenti (Exiled Exchange 2, Awakened PoE Trade e simili) leggono l'oggetto, estraggono gli affissi e lasciano all'utente il compito di scegliere quali usare nella ricerca. Velocizzano la ricerca di oggetti simili, ma non stimano il valore. In particolare:

- ignorano gli affissi scartati, che possono **abbassare** il valore (un raro con 3 mod buoni e 3 inutili vale meno di uno con 3 buoni e slot liberi da craftare);
- presuppongono che l'utente conosca già il mercato per scegliere gli affissi giusti;
- hanno un'interfaccia brutta.

L'obiettivo è uno strumento che **ragioni come un giocatore esperto**: guarda l'oggetto intero, decide da solo cosa conta e cosa penalizza, e restituisce un verdetto e un prezzo consigliato con una spiegazione. L'utente principale è l'autore, che sa già riconoscere più o meno un oggetto di valore ma fatica a capire **quanto** vale. Lo strumento deve però essere utile anche a chi conosce poco il mercato.

## 2. Obiettivi

1. **Verdetto rapido** su un oggetto in gioco (hotkey): `Pessimo` / `Buono` / `Ottimo` / `VENDI SUBITO`, in pochi secondi.
2. **Analisi approfondita** su richiesta: prezzo consigliato con fascia (min–max), livello di confidenza e spiegazione degli affissi che contribuiscono al valore o lo penalizzano.
3. **Valutazione della stash**: lettura degli oggetti di una stash tab e overlay sopra la griglia in gioco, con verdetto e prezzo per ogni oggetto, appena la tab è aperta.
4. **Strategia di prezzo per fascia**:

   | Verdetto | Obiettivo | Prezzo suggerito |
   |---|---|---|
   | Pessimo | non perderci tempo | nessuno (vendor / disenchant) |
   | Buono | vendita rapida | allineato alle inserzioni comparabili più basse |
   | Ottimo | massimizzare il ricavo | sopra la media dei comparabili, tempi di vendita più lunghi |
   | VENDI SUBITO | oggetto eccezionale | stima alta + avviso esplicito "pochi comparabili, verifica a mano" |

5. **Interfaccia curata**, progettata da zero.

## 3. Non-obiettivi (prima versione)

- Tipi di oggetto diversi dai **rari**: unici, gemme, gioielli speciali, waystone, tablet, currency verranno aggiunti in seguito, uno alla volta. L'architettura deve permetterlo (un "valutatore" per tipo di oggetto), ma la v1 li ignora.
- Messa in vendita automatica, invio di whisper, qualunque automazione dentro il gioco.
- Supporto a PoE1.
- Server centrale o servizio condiviso tra utenti: tutto gira in locale.
- Riconoscimento automatico della stash tab aperta tramite cattura dello schermo / OCR (valutabile in futuro).
- Registrazione delle vendite reali ("venduto a X") per calibrare il modello: la v1 usa solo i prezzi richiesti. Previsto come evoluzione successiva nello storico.
- Packaging curato, auto-update e firma del codice: la v1 è distribuita come sorgente + build manuale.

## 4. Anti-obiettivi (fallimento anche se "funziona")

- **Rischio per l'account**: niente lettura della memoria del client, niente iniezione, niente input inviati al gioco. Si usano solo appunti (Ctrl+C), l'API trade del sito e, per la stash, un endpoint web (vedi §6.4).
- **Falsa precisione**: dare un numero secco con sicurezza quando i dati sono pochi o rumorosi. La stima va sempre accompagnata da fascia e confidenza.
- **Impatto sul gioco**: l'overlay non deve rubare il focus, causare cali di FPS o interferire con gli input.
- **Superamento dei rate limit** dell'API trade, con conseguenti blocchi temporanei dell'IP o dell'account.
- **Interfaccia brutta o confusa**: è una delle ragioni per cui il progetto esiste.

## 5. Vincoli

- I prezzi sul trade sono **prezzi richiesti, non di vendita**: inserzioni vecchie, price fixing, prezzi assurdi. Il motore deve filtrarli (età dell'inserzione, outlier, venditori offline se l'informazione è disponibile).
- **Rate limit** dell'API trade (`/api/trade2/search` e `/api/trade2/fetch`): stretti e comunicati dagli header `X-Rate-Limit-*`. Tutte le chiamate passano da un'unica coda globale che li rispetta.
- **League e patch**: i prezzi e i pesi degli affissi cambiano a ogni league e a ogni bilanciamento. I dati raccolti sono legati alla league.
- **Stash API per PoE2**: la documentazione ufficiale indica le API stash dell'account come "PoE1 only" (vedi §6.4).
- Piattaforma: **Windows**, client PoE2 in modalità finestra o borderless (necessario per l'overlay).
- **Progetto pubblico open source**: il codice riusato da altri progetti (es. Exiled Exchange 2) deve avere una licenza compatibile con quella di POEvaluator, e l'attribuzione va mantenuta. Le chiamate all'API trade usano uno User-Agent che identifica l'applicazione, come richiesto da GGG.

## 6. Design

### 6.1 Approcci considerati

| Approccio | Pro | Contro |
|---|---|---|
| **A. Ricerche automatiche** — per ogni oggetto genera più query al trade (tutti gli affissi rilevanti, valori allentati, un mod alla volta in meno) e confronta i risultati | Nessuna infrastruttura dati, funziona dal primo giorno di league | Molte chiamate per oggetto, lento con i rate limit, impossibile un verdetto istantaneo o una stash intera in tempi brevi |
| **B. Modello statistico** — dataset di migliaia di inserzioni, modello addestrato su affissi/base/ilvl → prezzo | Verdetto istantaneo, considera da solo tutti gli affissi | Serve una pipeline dati; Public Stash API per PoE2 non garantita; crawling lento; riaddestramento per league/patch |
| **C. Ibrido** ✅ | Verdetto istantaneo dal modello, accuratezza dalle ricerche; il modello migliora con l'uso | Inizio league grezzo; più componenti da costruire |

**Scelto: C**, deciso dall'utente. Il verdetto rapido e l'overlay sulla stash usano il modello locale. L'analisi approfondita usa le ricerche di A. **Ogni inserzione restituita dalle ricerche viene salvata in un database locale** che alimenta il modello: più si usa lo strumento, più il verdetto rapido diventa preciso.

### 6.2 Piattaforma (decisa dall'utente)

**Electron + TypeScript**. Riferimento: Exiled Exchange 2 / Awakened PoE Trade, da cui riusare (se la licenza lo consente) il **parser del testo dell'oggetto** e il **database degli affissi** (mappatura testo mod → stat id del trade, tier, range).

### 6.3 Componenti

1. **Input oggetto**: hotkey globale → simula Ctrl+C (o Ctrl+Alt+C per il testo avanzato con tier e range) → legge gli appunti → parser → oggetto strutturato (classe, base, ilvl, rarità, affissi prefix/suffix con valore e tier, implicit, rune/socket, corrupted, ecc.).
   - *Nota*: l'invio di Ctrl+C al gioco è la pratica comune di tutti i price checker accettati; si tratta di un singolo input per pressione di tasto.
2. **Coda API trade**: client unico per search/fetch, rispetta gli header di rate limit, priorità (verdetto/analisi in primo piano > valutazione della stash > raccolta in background), retry con backoff.
2b. **Raccolta in background** (decisa dall'utente): quando la coda è libera, l'app interroga da sola il trade sulle combinazioni più comuni (basi e affissi rilevanti per ogni classe di oggetto, league corrente) e salva le inserzioni nel database locale, per alimentare il modello senza aspettare le analisi dell'utente. Usa solo il budget di rate limit residuo, si sospende appena arriva una richiesta dell'utente, ed è disattivabile dalle impostazioni. I pesi di partenza scritti a mano servono solo come fallback minimo a inizio league, non come contenuto esaustivo.
3. **Database locale** (SQLite): inserzioni raccolte (affissi normalizzati, base, ilvl, prezzo normalizzato, data di indicizzazione, league), cache delle ricerche, risultati delle valutazioni, configurazione.
4. **Normalizzazione prezzi**: conversione di tutte le valute in una valuta di riferimento (Exalted Orb, con visualizzazione anche in Divine) usando i tassi dell'exchange (es. poe.ninja per PoE2), aggiornati periodicamente.
5. **Motore di valutazione**:
   - **Valutatore rapido**: punteggio dell'oggetto da pesi per affisso × tier × classe di oggetto, con penalità per gli slot occupati da mod inutili. All'inizio usa pesi di partenza (regole scritte a mano + frequenza degli affissi nelle inserzioni costose); quando il database locale ha abbastanza dati per quella classe di oggetto, usa un modello sui comparabili locali. Produce il verdetto e un prezzo indicativo.
   - **Analisi approfondita**: strategia di ricerche multiple (approccio A). Identifica gli affissi "portanti", misura l'effetto dei mod deboli confrontando con oggetti simili più puliti, filtra gli outlier, calcola la fascia di prezzo e la confidenza in base al numero e alla dispersione dei comparabili. Applica la strategia di prezzo per fascia (§2.4).
   - Interfaccia comune `Valutatore` per tipo di oggetto, per aggiungere in seguito unici, gemme, ecc.
6. **Lettura della stash**: vedi §6.4.
7. **Overlay**:
   - *Pannello oggetto*: badge del verdetto vicino al cursore (rapido) ed eventualmente pannello dettagliato (analisi) con prezzo, fascia, confidenza, spiegazione per affisso, link alla ricerca equivalente sul sito trade.
   - *Overlay stash*: griglia trasparente sopra la stash tab, con colore per verdetto e prezzo su ogni cella. Richiede una **calibrazione** una tantum (posizione e dimensione della griglia per risoluzione).
   - Click-through, nessun furto di focus; visibile solo quando PoE2 è in primo piano.
8. **Finestra impostazioni/storico**: league, hotkey, soglie dei verdetti, valuta di riferimento, sessione per la stash, lista delle valutazioni passate, coda di valutazione.

### 6.4 Stash tab

- **Tentativo primario (deciso dall'utente)**: endpoint web usato dagli strumenti PoE1 di valutazione della ricchezza (`character-window/get-stash-items` con cookie `POESESSID`), provato sul realm PoE2. Restituisce gli oggetti con le coordinate (x, y) nella tab. Il cookie va salvato cifrato (Electron `safeStorage`). È una zona grigia: può smettere di funzionare, e l'utente deve essere avvisato del rischio quando inserisce il cookie.
- **Se in futuro esiste un'API OAuth ufficiale** per le stash PoE2 (`account:stashes`), va preferita.
- **Ripiego (deciso dall'utente)**: *coda tramite appunti*. L'utente fa Ctrl+C su ogni oggetto della tab, lo strumento accoda e valuta in background. In questo caso l'overlay sulla griglia non è disponibile (manca la posizione); si mostra una lista.
- **Primo passo di sviluppo**: uno spike che verifica se l'endpoint risponde per PoE2. Il risultato decide quale ramo costruire.
- **Scelta della tab (decisa dall'utente)**: l'utente sceglie nell'app quale tab valutare e mostrare in overlay (lista delle tab per nome) oppure le cicla con una hotkey. L'app non tenta di capire da sola quale tab è aperta in gioco. L'overlay della griglia si mostra con una hotkey o un toggle, sulla tab selezionata.

### 6.5 Flussi principali

1. *Verdetto rapido*: hotkey → parsing → valutatore rapido → badge (< 2 s, senza chiamate API se il modello locale basta; altrimenti una singola ricerca).
2. *Analisi approfondita*: seconda hotkey o click sul badge → ricerche multiple in coda (con progresso visibile) → pannello con prezzo e spiegazione → inserzioni salvate nel DB.
3. *Stash*: l'utente seleziona la tab nell'app (o la cicla con hotkey) → lettura della tab → verdetto rapido immediato per tutti gli oggetti → analisi approfondita in background per gli oggetti `Ottimo` e `VENDI SUBITO` → aggiornamento progressivo dell'overlay.

### 6.6 Milestone (mia proposta)

1. **M1: valutazione del singolo oggetto.** Parser, coda API, database, normalizzazione prezzi, raccolta in background, verdetto rapido, analisi approfondita, pannello oggetto, impostazioni minime. Prima della UI si approvano i mockup.
2. **M2: stash.** Spike sull'endpoint PoE2 → lettura della tab selezionata + overlay sulla griglia con calibrazione. Se lo spike fallisce: coda tramite appunti con vista a lista. Il ripiego fa comunque parte della v1.
3. **M3: storico e rifiniture.** Storico delle valutazioni, tuning delle soglie, prestazioni dell'overlay.

## 7. Criteri di successo

- Il verdetto rapido arriva in meno di 2 secondi e l'utente lo trova affidabile per decidere se tenere o vendere.
- Il prezzo dell'analisi approfondita è tale che gli oggetti `Buono` si vendono in tempi brevi e quelli `Ottimo` a un prezzo che l'utente non avrebbe saputo stimare da solo.
- Nessun problema con l'account e nessun blocco per rate limit nell'uso normale.

## 8. Lasciato al builder

- Algoritmo esatto del modello rapido (es. k-nearest-neighbours sui comparabili locali vs regressione) e soglia di dati oltre cui sostituisce i pesi di partenza. *Mia proposta*: partire con kNN, che non richiede addestramento ed è facile da spiegare all'utente.
- Strategia dettagliata delle ricerche nell'analisi approfondita, numero massimo di query per oggetto, regole di filtro degli outlier.
- Soglie numeriche dei verdetti (configurabili, con default ragionevoli).
- Scelta del framework UI dentro Electron, struttura del progetto, librerie per hotkey globali e SQLite.
- Verifica della licenza di Exiled Exchange 2 e modalità di riuso (fork parziale, copia dei dati, dipendenza); scelta della licenza di POEvaluator compatibile con quella.
- Strategia della raccolta in background: quali combinazioni interrogare, con che frequenza, quota di rate limit riservata.
- Design visivo dell'interfaccia: va prodotto con mockup e approvato dall'utente prima dell'implementazione della UI.
