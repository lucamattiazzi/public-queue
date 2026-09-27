# Dashboard locale e barra dei menu su macOS

L’agent include una dashboard nel browser e un’icona nella barra dei menu di macOS.
Non è necessario installare Electron o Xcode. Servono Node.js 24+ e un runtime locale
con un modello disponibile. Il componente nativo incluso supporta macOS 13+ su
Apple Silicon e Intel; valgono anche i requisiti macOS della versione Node installata.

## Installare o aggiornare

```sh
npm install -g @lucamattiazzi/public-queue-agent
```

L’installazione non avvia processi né apre finestre. Le credenziali esistenti in
`~/.config/public-queue/agent.json` vengono conservate. Ferma e riavvia un agent già
in esecuzione per usare il nuovo codice.

Se non hai ancora associato il dispositivo, apri la console del relay, crea il
pairing ed esegui il comando `pq-agent connect` mostrato. Le chiavi del progetto
servono solo nella console; non vengono richieste dalla dashboard locale.

## Avviare agent, dashboard e icona

```sh
pq-agent start
```

Su macOS apre il browser e mostra l’icona a tre barre nella barra dei menu.
La dashboard mostra soltanto i job del dispositivo associato:

- Totali dei job in attesa, in esecuzione, completati e falliti.
- ID, stato, orario di creazione e numero di tentativi.
- Prima i job attivi, poi la cronologia recente, fino a 100 righe.
- Server, dispositivo, runtime configurato e modelli consentiti.

La vista si aggiorna ogni tre secondi. I totali riguardano i job ancora conservati
sul relay, non tutta la cronologia dall’installazione. Se il relay non risponde,
la pagina segnala che i dati potrebbero essere obsoleti. Una coda vuota viene
mostrata come tale solo dopo una risposta riuscita.

Il menu mostra i conteggi di job in attesa/in esecuzione e offre:

- **Open dashboard**: riapre la pagina locale, anche dopo aver chiuso la scheda.
- **Quit agent**: ferma questo agent e rimuove l’icona. Un’inferenza interrotta
  può essere ripetuta dopo la scadenza del lease; non equivale a cancellare il job.

Chiudere la scheda del browser lascia l’agent attivo. Chiudere il terminale può
terminarlo: usa il servizio per mantenerlo in esecuzione.

```sh
pq-agent start --no-open   # Dashboard e icona, senza aprire subito il browser
pq-agent start --headless  # Solo worker, senza dashboard o icona
```

## Agent già in background

Il nuovo servizio macOS avvia l’agent, la dashboard e l’icona al login, senza aprire
il browser. L’uscita volontaria dal menu non provoca un riavvio immediato; un crash
può invece essere riavviato da launchd.

```sh
pq-agent service install
```

Se avevi già installato il vecchio servizio, prima esegui `pq-agent service uninstall`,
poi installalo nuovamente. Non avviare un secondo `start` mentre il servizio è attivo.

Per monitorare un agent headless o un servizio già avviato:

```sh
pq-agent gui
```

Questo comando apre solo il monitor, con la propria icona. **Non avvia un altro worker**.
Il menu offre **Close monitor**, che chiude soltanto il monitor. Se il servizio mostra
già l’icona, usa **Open dashboard** da quella anziché creare una seconda icona.

Tutti i comandi supportano `--config /percorso/agent.json`. Su Linux `gui` stampa il
link locale da aprire manualmente; la barra dei menu è disponibile soltanto su macOS.

## Sicurezza e limiti

La dashboard ascolta su una porta casuale di **127.0.0.1**, mai su tutte le interfacce.
Il relay viene contattato solo in uscita. Non serve aprire porte sul router.
La pagina locale usa una chiave temporanea distinta dalle credenziali dell’agent,
con controlli Host/Origin e senza CORS. Il link è privato; non condividerlo.

Prompt, risposte, token del relay, chiavi del runtime e chiavi private non sono
esposti alla pagina. Non contiene analytics. La prima versione è un monitor:
non cambia modelli o configurazione, non annulla job e non avvia il runtime LLM.
L’indicazione “Configured runtime” non è un controllo di salute: usa `pq-agent doctor`
per verificare che il runtime risponda.

Il relay deve includere `GET /v1/agent/queue`. Se manca, la dashboard chiede di
aggiornarlo; un vecchio relay continua comunque a supportare il normale worker.

## Manutenzione del componente nativo

Il sorgente è `packages/agent/native/MenuBar.swift`; il pacchetto contiene il relativo
eseguibile universal, senza librerie native di terze parti. Per ricompilarlo, su un Mac
con Xcode command-line tools:

```sh
node scripts/build-menubar.mjs
pnpm build
```

La build applica una firma ad hoc. Non è una distribuzione .app notarizzata con un
certificato Apple Developer. Le normali build Linux/Hetzner riusano il binario incluso
nel repository; non richiedono Swift.
