# Collegare Stripe agli account Premium

Questa integrazione è già implementata. Devi configurare il tuo account Stripe e le variabili sul server; non devi creare utenti Premium a mano né scrivere un secondo backend.

Il percorso è: **email verificata → account Free → Checkout → pagamento verificato → Premium sullo stesso account**. Chi sceglie Premium dalla landing passa comunque dalla creazione/accesso dell'account: il servizio deve sapere a chi attribuire il pagamento. Non usare un Payment Link generico al posto del checkout della dashboard, perché non conserva automaticamente questa associazione.

## 1. Prodotto e prezzo, prima in modalità test

Nel tuo account Stripe crea:

- Prodotto: `Public Queue Premium`.
- Prezzo: **€29,00 EUR all'anno**, ricorrente, quantità 1.
- Trattamento imposte del prezzo: **inclusive**.
- Nessun trial, prezzo a consumo o cambio di quantità per questo flusso.

Se hai già il prodotto Personal della versione precedente, puoi mantenere prodotto e `price_...`: Premium è il nuovo nome visualizzato. L'identificatore applicativo rimane `personal`.

Nel `.env` del server imposta:

```dotenv
PQ_PUBLIC_URL=https://queue.tuo-dominio.it
PQ_STRIPE_SECRET_KEY=sk_test_INSERISCI_LA_TUA_CHIAVE
PQ_STRIPE_PRICE_ID=price_INSERISCI_IL_TUO_PREZZO
PQ_STRIPE_WEBHOOK_SECRET=whsec_INSERISCI_IL_SECRET_DEL_WEBHOOK
PQ_STRIPE_AUTOMATIC_TAX=false
```

Questi sono segnaposto. Usa valori reali solo nel tuo file privato. Le tre variabili Stripe vanno configurate insieme; non mettere chiavi nel frontend. L'importo, la valuta, il periodo annuale e `tax_behavior=inclusive` vengono verificati dal backend prima di creare Checkout.

`PQ_STRIPE_AUTOMATIC_TAX=true` abilita il calcolo automatico quando hai configurato registrazioni fiscali e prodotto in Stripe Tax. La configurazione fiscale dipende dalla tua attività: vedi [MONETIZATION.md](MONETIZATION.md). Il codice non si occupa automaticamente di tutti gli adempimenti contabili.

## 2. Webhook che mantiene il piano aggiornato

In Stripe Workbench configura una destinazione webhook HTTPS:

```text
https://queue.tuo-dominio.it/v1/billing/webhook
```

Seleziona questi eventi:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
```

Copia il signing secret della **specifica destinazione** in `PQ_STRIPE_WEBHOOK_SECRET`. Non è la chiave API e non è intercambiabile con quella di un webhook diverso. L'SDK attualmente bloccato nel lockfile usa la versione API `2026-08-26.dahlia`; mantieni coerente la destinazione quando aggiorni Stripe.

Il server verifica la firma sul body originale, riconosce il customer associato all'account e consulta lo stato attuale della subscription su Stripe. Non presume che gli eventi arrivino in ordine. Gli ID evento già elaborati vengono conservati per rendere idempotenti le consegne duplicate. Questo segue il modello asincrono descritto nella [documentazione Stripe sui webhook delle subscription](https://docs.stripe.com/billing/subscriptions/webhooks) e sulla [verifica delle firme](https://docs.stripe.com/webhooks).

## 3. Portale clienti

Nelle impostazioni Stripe Customer Portal abilita:

- consultazione delle fatture;
- aggiornamento del metodo di pagamento;
- cancellazione del rinnovo **a fine periodo**.

Disabilita cambi di prezzo/piano/quantità: l'app vende un solo piano a pagamento. Configura inoltre le comunicazioni di pagamento fallito/rinnovo e gli eventuali retry Stripe. Il pulsante **Manage billing & cancellation** apre una sessione del portale per il customer dell'utente autenticato. [Documentazione del portale](https://docs.stripe.com/customer-management).

Ricrea il container dopo aver modificato `.env`:

```sh
docker compose -f compose.hetzner.yaml up -d --build
```

## 4. Come account e pagamento rimangono collegati

Nel database persistente vengono conservati:

| Campo | Funzione |
|---|---|
| `accounts.id` | Identità interna dell'utente |
| `stripe_customer` | Customer Stripe associato, univoco |
| `subscription` | Subscription corrente |
| `subscription_status` | Stato verificato su Stripe |
| `paid_until` | Fine del periodo concesso dopo conferma pagamento |
| `cancel_at_period_end` | Rinnovo annullato, periodo corrente ancora attivo |

Il customer viene creato dal backend per l'utente autenticato. La metadata `accountId` aiuta il riferimento su Stripe, ma l'app non assegna piani fidandosi di una email o di metadata ricevuti dal browser. Il customer ID memorizzato nel database è il collegamento operativo. Proteggi e fai backup del database: conservare solo le chiavi Stripe non conserva gli account.

| Evento/stato verificato | Effetto sul piano |
|---|---|
| Registrazione senza acquisto | Free |
| Redirect alla pagina “success” senza pagamento verificato | Nessun upgrade |
| Subscription attiva, prezzo corretto, ultima fattura pagata | Premium fino a `paid_until` |
| Rinnovo pagato | Estensione di `paid_until` al nuovo periodo |
| Annullamento a fine periodo | Premium fino alla scadenza già pagata |
| Pagamento fallito / `past_due` | Nessuna estensione del periodo già concesso |
| Scadenza locale senza rinnovo confermato | Free automaticamente, anche senza un nuovo webhook |
| Cancellazione immediata / `unpaid` / `paused` | Accesso pagato rimosso dopo sincronizzazione |
| Account presente in `PQ_OWNER_EMAILS` | Owner, indipendente da queste variazioni |

Un checkout ripetuto riusa la sessione quando possibile; viene controllata l'esistenza di subscription per evitare acquisti duplicati. Una risposta persa durante la creazione viene recuperata dalle sessioni aperte su Stripe.

Non c'è polling periodico di riconciliazione Stripe: l'aggiornamento dei pagamenti dipende dai webhook verificati; la **scadenza locale** impedisce di mantenere Premium per sempre quando una notifica manca. Monitora le consegne fallite e reinvia gli eventi dopo aver risolto il problema. Non modificare `paid_until` manualmente per nascondere un errore di sincronizzazione.

## 5. Collaudo prima degli incassi

Usa un account di prova la cui email **non sia in `PQ_OWNER_EMAILS`**, altrimenti non vedrai i limiti né il pulsante di acquisto.

1. Registralo e controlla che sia Free.
2. Premi Premium dalla dashboard e completa Checkout con i metodi di prova Stripe.
3. Controlla l'esito dei webhook in Workbench e verifica che `/app/` mostri Premium e la data di scadenza.
4. Reinvia lo stesso evento: non deve creare un altro account né estendere nuovamente la durata.
5. Annulla il rinnovo dal portale: l'accesso deve restare fino alla fine del periodo pagato.
6. Verifica rinnovo pagato, pagamento fallito e scadenza in ambiente di test. I test automatici simulano questi stati, ma non sostituiscono il collaudo del tuo account Stripe.
7. Ripeti prodotto/prezzo, webhook e portale in modalità live; sostituisci insieme secret API, prezzo e signing secret con quelli live e ricrea il container.

L'uso quotidiano non richiede assegnazioni manuali del piano. Sono necessari Stripe raggiungibile, webhook funzionanti e database persistente.

## Problemi comuni

- **Pagamento riuscito ma account Free:** controlla customer associato, ID prezzo, firma webhook, modalità test/live e risposta HTTP della consegna. Reinvia l'evento dopo la correzione. Non usare il redirect come prova di pagamento.
- **Checkout non disponibile:** controlla tutte e tre le variabili, configurazione operatore e caratteristiche del prezzo. Il backend rifiuta un importo o intervallo diverso.
- **`use_billing_portal`:** esiste già una subscription; usa il portale per recuperare il pagamento o cancellarla, non creare un doppione.
- **Owner già abbonato:** l'esenzione non cancella gli addebiti. Annulla tu il rinnovo dal portale se non lo desideri.
- **Rimborso:** gestiscilo su Stripe; rimborsare da solo non cancella la subscription. Cancella anche l'abbonamento se vuoi terminare l'accesso. Le dispute richiedono gestione operativa.
- **Cambio prezzo futuro:** non sostituire alla cieca `PQ_STRIPE_PRICE_ID`: il codice attuale riconosce un solo prezzo e non migra le vecchie subscription. Serve una modifica esplicita per mantenere più prezzi attivi.

Implementazione di riferimento: `packages/server/src/billing.ts`, `accounts.ts`, `saas.ts` e `packages/protocol/src/plans.ts`. Le credenziali e i pagamenti reali non vengono creati da questi README.
