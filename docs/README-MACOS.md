# Public Queue per macOS

Public Queue collega i modelli del tuo Mac a un frontend tramite una coda persistente.
L’app resta nella barra dei menu e contatta il relay solo in uscita. Non serve
installare Node.js, npm, Docker o Xcode. Il runtime LLM resta un’app separata.

## Installazione

Richiede **macOS 14 o successivo**, su Apple Silicon o Intel.

1. Apri il DMG e trascina **Public Queue** in **Applicazioni**.
2. Apri Public Queue una volta. La copia in Applicazioni da sola non avvia processi.
3. Avvia Ollama, LM Studio, llama.cpp, oMLX o vLLM e carica un modello.
4. Scegli il runtime e premi **Ottieni un codice sul sito**. Il sito predefinito è
   `https://jobboard.grokked.it`; puoi cambiarlo nelle **Impostazioni avanzate**.
5. Nella console del sito crea un dispositivo. Incolla il codice monouso nell’app
   e premi **Collega questo Mac**. Il codice dura dieci minuti.

L’app verifica il runtime, salva le chiavi localmente e avvia l’agent. Se non indichi
un modello nelle impostazioni avanzate, usa il primo disponibile. L’avvio al login
viene abilitato al primo collegamento; puoi disattivarlo dalla finestra dell’app o
nelle Impostazioni di Sistema. Se macOS richiede approvazione, concedila in
**Generali → Elementi login**.

La preview attuale è firmata ad hoc, **non notarizzata**. Non è ancora una
release con firma Developer ID per distribuzione senza avvisi Gatekeeper.

## Uso quotidiano

Quando vedi **Il tuo Mac è collegato**, non devi rifare il pairing.

- **Apri la coda nel browser** mostra stato e cronologia dei job del dispositivo.
- Chiudere la finestra o la scheda del browser lascia l’agent attivo.
- L’icona a tre barre nella barra dei menu permette di riaprire l’app o la coda,
  fermare/avviare l’agent, oppure uscire completamente.
- **Esci da Public Queue** ferma anche l’agent. L’apertura al prossimo login rimane
  attiva se l’hai abilitata. Per disabilitarla, togli la spunta nell’app.
- Un crash dell’agent viene seguito da un nuovo tentativo dopo dieci secondi.
  Se termina l’app stessa, il processo agent termina senza rimanere orfano.

La dashboard mostra solo metadati della coda, non prompt o risposte. Ascolta
esclusivamente su `127.0.0.1`, protetta da un token locale temporaneo. Le richieste
LLM partono dal frontend: l’app macOS non è una chat e non carica modelli.

## Collegare il frontend

Apri **Collega un frontend…**, copia la **chiave pubblica**, poi apri la console
del relay. Crea una connessione browser per questo dispositivo verificando la
chiave. Integra quella connessione con il [SDK frontend](README-FRONTEND.md).
La chiave pubblica non è la credenziale privata del frontend.

## Scegliere modelli diversi per i job

Apri **Modelli e profili…**. Puoi aggiungere destinazioni locali o cloud e associare
`fast`, `quality`, `vision` e `cloud` ai modelli desiderati. Non serve rifare il pairing
é riavviare l’agent. Vedi [configurazione e uso dal frontend](README-PROFILES.md).

## Cambiare sito o connessione iniziale

Apri **Modifica connessione…**. In **Impostazioni avanzate** puoi cambiare sito,
URL del runtime, modelli consentiti e l’eventuale chiave API del runtime.
Per applicare la modifica crea un nuovo dispositivo sul sito e usa il suo codice.
La connessione precedente resta attiva fino al buon esito del nuovo pairing.
I vecchi file delle chiavi vengono conservati; puoi revocare i vecchi dispositivi
nella console quando non servono più.

Le configurazioni dell’app sono salvate con permessi `0600` in
`~/Library/Application Support/Public Queue/`. Non vengono caricate sul relay.
L’app non importa né modifica automaticamente gli agent CLI o il supervisore Chess:
usa un dispositivo separato per evitare due worker sulla stessa identità.

## Aggiornare e rimuovere

Esci dall’icona della barra dei menu, sostituisci l’app in Applicazioni e riaprila.
Configurazione e pairing restano salvati. Per rimuoverla, disattiva prima l’avvio
al login, esci e sposta l’app nel Cestino. Le chiavi restano nella cartella indicata;
eliminale solo se non servono per recuperare il dispositivo.

## Build, firma e notarizzazione

```sh
pnpm package:macos
pnpm exec tsx --test tests/macos-app.test.ts tests/agent-cli-gui.test.ts
```

Il build scarica Node 24.19.0 dalle distribuzioni ufficiali, verifica gli SHA256,
compila il launcher Swift per entrambe le architetture e produce app, ZIP e DMG
in `dist/macos/`. Le licenze dei componenti sono incluse nel bundle.

Per distribuire la versione notarizzata, installa un certificato **Developer ID
Application** nel Portachiavi e configura un profilo `notarytool`. Le credenziali
non devono essere salvate nel repository. Quindi:

```sh
PQ_MAC_SIGN_IDENTITY='Developer ID Application: NOME (TEAMID)' \
PQ_MAC_NOTARY_PROFILE='nome-profilo-portachiavi' \
pnpm package:macos
```

Il processo firma Node e l’app con Hardened Runtime, invia l’archivio ad Apple,
applica il ticket di notarizzazione e verifica Gatekeeper prima di impacchettare
il DMG. Il DMG viene a sua volta firmato, notarizzato e corredato del ticket.
Senza quelle variabili il risultato è soltanto una build locale firmata ad hoc.
