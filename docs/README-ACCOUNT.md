# Creare il tuo account e usarlo senza quote commerciali

Sono disponibili Free, Premium (€29/anno) e un'esenzione privata **Owner** per il gestore. Owner non è un piano acquistabile e non conferisce automaticamente credenziali amministrative per gli altri account.

## Sul tuo server: il tuo account Owner

1. Genera `.env` con `node scripts/setup-env.mjs` se non esiste già. Non sovrascrivere un `.env` già configurato.
2. Completa dominio, dati operatore e SMTP come in [DEPLOYMENT.md](DEPLOYMENT.md).
3. Aggiungi la tua email esatta, quella di cui controlli la casella:

   ```dotenv
   PQ_OWNER_EMAILS=la-tua-email@example.com
   ```

   Puoi indicare più indirizzi separati da virgole. Sono normalizzati in minuscolo; non sono ammessi wildcard o interi domini. Questa lista deve restare nel server, mai nel frontend.
4. Avvia o ricrea il container per caricare l'ambiente:

   ```sh
   docker compose -f compose.hetzner.yaml up -d --build
   ```

   Se usi il tuo reverse proxy con `compose.yaml`, usa `docker compose up -d --build`. Un semplice `restart` non ricarica le variabili Compose modificate.
5. Apri `https://TUO-DOMINIO/login/`, inserisci la stessa email e accetta i termini. Apri il link ricevuto nello **stesso browser** e premi Continue. La verifica della casella è richiesta anche per Owner.
6. In `/app/` vedrai **Owner**, `no commercial quotas` e nessun pulsante per acquistare Premium. Non devi inserire una carta né configurare Stripe per il tuo uso.

L'esenzione vale anche per un account già esistente: non devi ricrearlo o modificare SQLite. Togliendo l'email e ricreando il container, torneranno le normali quote: Premium se il periodo pagato è ancora valido, altrimenti Free. Un precedente abbonamento Stripe **non viene cancellato** aggiungendo l'email: se ne hai uno, annulla il rinnovo dal portale per evitare altri addebiti.

Nessun account personale è stato precreato e nessuna email è stata indovinata: scegli l'indirizzo nella configurazione.

## Provarlo subito in locale, senza SMTP e senza Stripe

Richiede Node.js 24+ e pnpm 11. Dalla cartella del repository:

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/setup-env.mjs
```

L'ultimo comando va eseguito solo se `.env` non esiste. Modifica questi valori nel file, conservando il segreto amministrativo generato:

```dotenv
PQ_PUBLIC_URL=http://127.0.0.1:8791
PORT=8791
PQ_DATABASE=.data/local-owner.sqlite
PQ_OWNER_EMAILS=la-tua-email@example.com
PQ_OPERATOR_NAME=Local development
PQ_OPERATOR_ADDRESS=Local development
PQ_OPERATOR_TAX_ID=Local development
PQ_SUPPORT_EMAIL=la-tua-email@example.com
PQ_DEV_MAIL_DIR=.data/mail
PQ_SMTP_HOST=
PQ_STRIPE_SECRET_KEY=
PQ_STRIPE_WEBHOOK_SECRET=
PQ_STRIPE_PRICE_ID=
```

Avvia:

```sh
node --env-file=.env dist/packages/server/cli.js
```

Apri `http://127.0.0.1:8791/login/` e richiedi il link per l'email configurata. L'email **non viene inviata**: è scritta in un file `.txt` nella cartella privata `.data/mail/`. Apri il file più recente, copia il link nello stesso browser e conferma. Non pubblicare questi file: contengono link di accesso temporanei. Se la porta è già occupata, cambia insieme `PORT` e `PQ_PUBLIC_URL`.

Questa modalità è solo locale: non impostare `NODE_ENV=production` e non usarla con un dominio pubblico. Per il server pubblico configura SMTP vero e rimuovi `PQ_DEV_MAIL_DIR`. Non usare il preflight di produzione per questa configurazione HTTP locale.

## Collegare il tuo modello

1. Avvia Ollama/LM Studio/llama.cpp/oMLX/vLLM sulla macchina di inferenza.
2. In `/app/` crea un dispositivo e scegli il runtime.
3. Installa l'agent dal tuo servizio:

   ```sh
   npm install -g https://TUO-DOMINIO/downloads/agent.tgz
   ```

   Nel test locale usa `http://127.0.0.1:8791/downloads/agent.tgz` sulla stessa macchina. Esegui poi il comando di pairing mostrato dalla dashboard.
4. Esegui `pq-agent doctor`, poi `pq-agent start`. Per un servizio utente macOS/Linux, dopo installazione puoi usare `pq-agent service install`.
5. Copia la chiave pubblica di `pq-agent key` nella dashboard, crea una connessione e aprila nel playground. Usa il nome esatto di un modello consentito sull'agent.

Il piano è del tuo account e si applica anche ai job inviati dal tuo frontend statico con le sue connessioni. Il server di casa continua a fare soltanto richieste in uscita.

## Che cosa significa “senza limiti”

Owner non ha quote commerciali su dispositivi, connessioni client, job/giorno, job/mese, job pendenti o budget payload. I risultati terminali non vengono eliminati automaticamente per retention: devi gestire disco e cancellazione account. I payload delle richieste vengono comunque cancellati a completamento/scadenza; non è un archivio di prompt.

Restano le protezioni del protocollo: body HTTP 1,5 MB, risposta di inferenza 1 MB, deadline massima 7 giorni (24 ore predefinite), una inferenza simultanea per dispositivo, lease/retry, autenticazione, rate limit antiabuso e limiti fisici della macchina. Anche signup e invio email mantengono i tetti globali. “Senza quote” non significa disco infinito o disattivare la sicurezza.

Per le quote pubbliche vedi [README-PLANS.md](README-PLANS.md); per Premium e rinnovi [README-STRIPE.md](README-STRIPE.md).
