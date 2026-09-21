# Free, Premium e Owner

| Limite | Free | Premium | Owner privato |
|---|---:|---:|---:|
| Prezzo | €0 | €29/anno | €0, esenzione operatore |
| Dispositivi | 1 | 3 | Senza quota |
| Connessioni client | 3 | 20 | Senza quota |
| Job/mese UTC | 500 | 10.000 | Senza quota |
| Job/giorno UTC | 50 | 1.000 | Senza quota |
| Job pendenti | 8 | 100 | Senza quota |
| Budget payload | 16 MiB | 256 MiB | Senza quota |
| Retention risultati terminali | 1 giorno | 7 giorni | Nessuna eliminazione per età |
| Deadline massima del job | 1 giorno | 7 giorni | 7 giorni, vincolo tecnico |

La deadline predefinita è sempre 24 ore. Ogni job pendente riserva 2 MB nel budget payload, oppure 4 MB se streaming. I limiti sono controllati sul server: cambiare JavaScript, valori del form o la risposta visualizzata nel browser non cambia il piano.

## Creazione e cambio di piano

- La registrazione con email verificata crea un account Free e un progetto cifrato.
- Un pagamento confermato da Stripe abilita Premium sullo stesso account; non crea un secondo utente.
- Il prezzo annuale e il prodotto vengono scelti dal server, non dal frontend.
- Un indirizzo nella variabile privata `PQ_OWNER_EMAILS`, dopo verifica email, riceve Owner. I webhook Stripe non rimuovono questa esenzione.
- Owner non compare nel listino pubblico e il checkout gli viene negato perché non serve un abbonamento.

Nel codice/API l'identificatore Premium resta `personal`, per compatibilità con connessioni e integrazioni esistenti. Il nome visualizzato è `Premium`. Non è necessario cambiare l'ID prezzo Stripe già configurato per rinominare il piano. Owner ha ID `owner` e `null` nei campi di quota: significa assenza di quota, non zero e non un numero artificiosamente enorme.

## Alla scadenza

Alla fine del periodo pagato, se non c'è un rinnovo confermato, tornano le quote Free. I dispositivi/client eccedenti sono sospesi per nuovo lavoro ma non perdono le chiavi: restano disponibili i primi creati ancora attivi entro la quota. Puoi revocare quelli vecchi per scegliere quali usare. Un upgrade ripristina l'accesso agli altri. I job già in esecuzione possono terminare; quelli sospesi possono scadere alla loro deadline.

La retention del piano corrente si applica anche ai risultati precedenti: esporta ciò che vuoi conservare prima del downgrade. Rimuovere l'esenzione Owner riattiva anche la pulizia per età. I contatori mensili non si azzerano cancellando risultati; si basano sul mese UTC.

## Modificare le quote

La sorgente è `packages/protocol/src/plans.ts`. Ricostruisci e ridistribuisci il server dopo una modifica. La pagina prezzi aggiorna i valori tramite `/v1/public`; mantieni coerenti anche il contenuto HTML statico e la documentazione. Non cambiare un prezzo già venduto senza gestire rinnovi e comunicazioni: la verifica del prezzo Stripe è anche in `packages/server/src/billing.ts`.

Le quote commerciali non sostituiscono limiti tecnici, capacità della macchina o monitoraggio del disco. L'esenzione Owner non si ottiene passando `owner` o una email in un job: la risoluzione avviene dal progetto dell'account autenticato.
