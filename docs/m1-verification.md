# Verifica M1 in gioco

Da compilare durante la sessione di prova. Avvio: `npm run dev` da un terminale, che resta aperto per leggere i log (righe `[poevaluator] …`).

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
| 8 | `Alt+Shift+D` su un raro | pannello con avanzamento, poi risultato | |
| 9 | Click su "Apri sul trade" | si apre la ricerca nel browser | |
| 10 | Alt+Tab fuori dal gioco | overlay nascosto, hotkey inattive | |
| 11 | Impostazioni dal tray: cambio soglia e salvataggio | valore mantenuto dopo il riavvio | |
| 12 | Scaling di Windows diverso dal 100% (se usato) | badge allineato al cursore | |

## 3. Raccolta in background (30 minuti)

Ogni 5 minuti il terminale stampa `inserzioni in archivio: {…}`; ogni risposta 429 del trade stampa `429 dal trade (…)`.

| Controllo | Atteso | Esito |
|---|---|---|
| Righe `429 dal trade` | nessuna | |
| `inserzioni in archivio` | i conteggi crescono | |

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

-
