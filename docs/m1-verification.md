# Verifica M1 in gioco

Da compilare durante la sessione di prova. Avvio: `npm run dev` da un terminale, che resta aperto per leggere i log (righe `[poevaluator hh:mm:ss] …`).

## 1. Controlli automatici (eseguiti il 2026-11-12)

| Controllo | Esito |
|---|---|
| `npm test` | 195 test passati |
| `npm run typecheck` | pulito |
| `npm run lint` | pulito |
| `npm run build` | riuscito |

## 2. Overlay e hotkey

| # | Prova | Atteso | Esito |
|---|---|---|---|
| 1 | Avvio con PoE2 aperto | icona nel tray, nessun errore nel terminale | |
| 2 | `Alt+D` su un raro | badge accanto al cursore in meno di 2 s | |
| 3 | Subito dopo il badge, muovere il personaggio | il gioco risponde, il focus resta al gioco | |
| 4 | Spostare il mouse di molto / attendere 4 s | il badge si chiude | |
| 5 | `Esc` con badge aperto | il badge si chiude | |
| 6 | `Alt+D` su un unico | "Oggetto non supportato" | |
| 7 | `Alt+D` senza oggetto sotto il mouse | "Nessun oggetto trovato…" | |
| 8 | `Alt+Shift+D` su un raro | pannello con avanzamento, poi risultato | ferma a 6/8, risultato dopo circa 10 minuti; chiudendo il pannello l'analisi non si annulla; rifacendola sullo stesso oggetto riparte da zero |
| 9 | Click su "Apri sul trade" | si apre la ricerca nel browser | |
| 10 | Alt+Tab fuori dal gioco | overlay nascosto, hotkey inattive | |
| 11 | Impostazioni dal tray: cambio soglia e salvataggio | valore mantenuto dopo il riavvio | |
| 12 | Scaling di Windows diverso dal 100% (se usato) | badge allineato al cursore | |

Altre osservazioni della prova (2026-11-12):
- la valutazione rapida usa sempre i pesi (0 oggetti simili, avviso "Pochi oggetti simili raccolti");
- l'elenco delle league nelle impostazioni è lento a caricarsi;
- nei contributi degli affissi "+97 to maximum Mana" e "+28 to maximum Mana" compaiono come due righe con la stessa stat.

## 3. Raccolta in background (30 minuti)

Ogni 5 minuti il terminale stampa `inserzioni in archivio: {…}`; ogni risposta 429 del trade stampa `429 dal trade (…)`.

| Controllo | Atteso | Esito |
|---|---|---|
| Righe `429 dal trade` | nessuna | sporadiche: `data` all'avvio, `fetch` a metà sessione (il sito del trade era usato in parallelo) |
| `inserzioni in archivio` | i conteggi crescono | quasi fermi: boots fisso a 83, gloves 38, wand da 9 a 27 |

## 4. Confronto con 5 rari

Per ogni oggetto: analisi approfondita, poi ricerca manuale sul sito del trade con gli stessi affissi principali.

| # | Oggetto (base, affissi principali) | Verdetto | Prezzo consigliato | Prezzi trade (manuale) | Differenza / note |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |

## 5. Problemi trovati

Diagnosi dopo la prova del 2026-11-12:
- **D1** – il client del trade attendeva il rate limit tenendo occupata la coda: un job della raccolta in attesa bloccava per minuti league e analisi approfondite.
- **D2** – la raccolta ordinava per prezzo crescente con seed fissi (sempre le stesse inserzioni) e girava su tutte le classi, raramente su quella che serviva.
- **D3** – la raccolta usava fino a metà del budget di ricerca anche subito prima di un'analisi approfondita.
- **D4** – chiudere il pannello non annullava l'analisi approfondita.
- **D5** – due mod con la stessa stat restavano separati.

## 6. Correzioni dopo la prova

| Problema | Correzione |
|---|---|
| D1 | La coda del trade non attende più tenendo un job: parte il job pronto (limiter del suo endpoint libero) di priorità più alta, FIFO a parità. Un job non parte se uno più importante attende lo stesso limiter. Un 429 rimette il job in coda (al massimo 3 ripetizioni) invece di bloccare la coda. Resta una sola richiesta HTTP in volo. |
| D4 | Chiudendo il pannello (X o Esc) durante l'analisi, l'overlay invia `valuation:cancel`: le richieste in coda vengono tolte, il risultato di quella in volo si scarta, il pannello non riceve nulla e una nuova analisi può partire subito. Le inserzioni già scaricate restano nel database. |
| Nessuna cache | Le analisi approfondite restano in memoria 30 minuti (al massimo 50, per league e testo dell'oggetto). Rivalutando lo stesso oggetto il risultato arriva subito e il piede del pannello mostra "Analisi di N min fa" ("Analisi di poco fa" sotto il minuto). |
| League lente | Le league sono salvate in `leagues.json` nella cartella dei dati dell'app: le impostazioni le mostrano subito e si aggiornano in background se il file ha più di 24 ore (anche all'avvio). L'elenco si aggiorna nella finestra aperta quando arriva quello nuovo. |
| D2, D3 | La raccolta ordina per inserzione più recente. Le classi valutate con meno di 30 inserzioni vanno in testa a una lista (al massimo 5) e vengono servite per prime finché arrivano a 60. La raccolta è ferma durante un'analisi approfondita, per 3 minuti dopo e nel primo minuto dall'avvio. |
| D5 | Gli explicit con la stessa stat diventano un solo affisso con i valori sommati e i testi uniti da " · " (le inserzioni li sommavano già). |

