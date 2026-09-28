# Modelli e profili

Public Queue può usare più destinazioni sullo stesso agent: ogni destinazione
associa un **modello**, un **endpoint OpenAI-compatible** e un’eventuale **chiave API**.
Il frontend può chiedere un modello preciso oppure uno dei profili configurati sul Mac.

## Configurazione nell’app macOS

Apri **Modelli e profili…** dalla finestra principale.

1. La destinazione attuale è già presente. `fast` e `quality` iniziano dal primo
   modello della configurazione esistente, senza cambiare pairing o credenziali.
2. Con **Aggiungi** registra altri modelli: nome descrittivo, nome esatto del modello,
   endpoint comprensivo di `/v1`, tipo Locale/Cloud e chiave API facoltativa.
3. Associa i profili alle destinazioni e premi **Salva e applica**.

| Profilo | Uso suggerito | Predefinito |
| --- | --- | --- |
| `fast` | Estrazione, classificazione, richieste brevi | Primo modello già configurato |
| `quality` | Generazione e ragionamento | Stesso modello di `fast` |
| `vision` | Destinazione dedicata | Non assegnato |
| `cloud` | Provider esterno esplicitamente scelto | Non assegnato |

I nomi sono etichette di routing: non misurano qualità, velocità o capacità del
modello. **Il formato attuale dei job accetta testo, non immagini**: assegnare
`vision` non introduce input multimodale. Non c’è un classificatore LLM che scelga
automaticamente il profilo: lo sceglie il frontend in base al compito.

Una destinazione può servire più profili. Più destinazioni possono usare lo stesso
endpoint con modelli diversi. Il runtime deve rendere disponibili quei modelli;
l’agent non installa pesi e non gestisce RAM, caricamento o scaricamento. Se il
runtime carica un modello su richiesta, vale il suo comportamento ordinario.

Le modifiche vengono salvate atomicamente nel file privato del dispositivo e lette
all’inizio di ogni job. Il job già avviato mantiene endpoint, modello e credenziale
selezionati; non viene interrotto. Rimuovere una destinazione disassegna i suoi
profili. Un profilo non assegnato produce un errore leggibile, senza usare altri modelli.

## Frontend

Non serve aggiornare il relay o il SDK: `model` rimane una stringa nello stesso
formato di richiesta, incluso il percorso streaming e gli adapter fetch.

```ts
import { PublicQueue } from '@lucamattiazzi/public-queue-sdk';

const queue = new PublicQueue(connection);
const job = await queue.submit({
  model: 'profile:fast',
  messages: [{ role: 'user', content: 'Estrai ingredienti e quantità da questo testo…' }],
});
const result = await queue.wait(job.id);
```

Per richiedere una destinazione tramite il modello preciso:

```ts
const job = await queue.submit({
  model: 'qwen-flash-next',
  messages: [{ role: 'user', content: 'Scrivi una breve introduzione.' }],
});
```

Se due destinazioni registrate usano lo stesso nome di modello, la richiesta esplicita
è ambigua e viene rifiutata: usa un profilo per indicare quella desiderata.
I nomi di modello che iniziano con `profile:` sono riservati ai profili.

## Cloud e riservatezza

Per una destinazione Cloud devi consentire esplicitamente l’invio dei prompt e i
costi del provider. Il profilo `cloud` può essere assegnato solo a una destinazione
Cloud. Puoi assegnare una destinazione Cloud autorizzata anche a `quality` o `fast`;
la finestra ne indica sempre il tipo. Contrassegna correttamente come Cloud gli
endpoint esterni: il tipo è una scelta dell’operatore, non una classificazione automatica della rete.

Non esiste fallback automatico: un errore, un modello assente o un timeout non
spostano il job a un altro provider. Una destinazione Cloud non autorizzata viene
rifiutata prima di effettuare la chiamata, anche se richiesta per nome preciso.
I provider esterni devono esporre l’API `/chat/completions` compatibile; non sono
inclusi adapter per API proprietarie. Nessuna chiamata a provider commerciali viene
eseguita durante il salvataggio delle impostazioni.

La risoluzione avviene **dopo la decifratura sul Mac**. Endpoint e chiavi API restano
nel file locale con permessi `0600`; il relay non riceve la configurazione di routing.
La dashboard locale mostra soltanto modelli, endpoint e associazioni dei profili,
mai le chiavi API. Il provider cloud scelto riceve necessariamente il prompt in
chiaro a livello applicativo, tramite HTTPS. Il costo dell’inferenza è a carico del
proprietario della credenziale del provider.
