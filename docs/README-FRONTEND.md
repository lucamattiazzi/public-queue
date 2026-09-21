# Collegare una chat esistente: OpenAI e Vercel AI SDK

La SDK offre due adapter `fetch`: conservi la tua libreria chat e sostituisci il trasporto. Prompt, blocchi progressivi e risultato vengono cifrati prima di passare dal relay. Non serve un backend della tua app statica.

## Installazione e connessione

```sh
npm install https://TUO-DOMINIO/downloads/sdk.tgz
```

Ottieni `connection` dal tuo account: server, token del client, ID dispositivo e chiave pubblica verificata sull'agent. È una credenziale personale da fornire alla propria app, non una costante da pubblicare nel bundle. Non usare una chiave API OpenAI. Esegui l'adapter nel browser per la cifratura browser→homelab: se lo esegui in un backend, quel backend vede il prompt prima della cifratura.

Aggiorna anche server e agent alla versione che supporta gli stream. Il runtime deve fornire Chat Completions testuali e SSE quando riceve `stream: true`. La modalità senza streaming rimane disponibile.

## OpenAI JavaScript SDK: cambia il fetch

Nel progetto che usa già `openai`:

```ts
// chat.ts
import OpenAI from 'openai';
import { PublicQueue, createOpenAIFetch, type Connection } from '@public-queue/sdk';

export function connectLocalChat(connection: Connection) {
  const queue = new PublicQueue(connection);
  const client = new OpenAI({
    // Segnaposto: l'adapter intercetta la richiesta e non contatta questo dominio.
    baseURL: 'https://public-queue.invalid/v1',
    apiKey: 'local-model-placeholder',
    dangerouslyAllowBrowser: true,
    // La coda gestisce i retry con lo stesso ID. Evita retry esterni che
    // potrebbero trasformare una nuova chiamata in una nuova inferenza.
    maxRetries: 0,
    fetch: createOpenAIFetch(queue, {
      onJob: job => localStorage.setItem('last-local-job', job.id),
      onStatus: job => console.log('Queue status:', job.status),
    }),
  });
  return { client, queue };
}

export async function sendPrompt(connection: Connection, model: string, prompt: string) {
  const { client } = connectLocalChat(connection);
  const stream = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  });
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta.content ?? '';
    // Sostituisci console.log con l'aggiornamento della tua UI esistente.
    console.log(text);
  }
}
```

Senza `stream: true`, la stessa chiamata restituisce un normale oggetto `chat.completion` alla fine del job. L'adapter non invia l'header Authorization della SDK OpenAI al relay: usa la connessione Public Queue. Il segnaposto `apiKey` non è una chiave del provider e non concede accesso a modelli remoti.

Il sottoinsieme supportato comprende `model`, messaggi testuali con ruoli `system/user/assistant`, `temperature`, `max_tokens` e `stream`. Le opzioni non supportate restituiscono errore 400 prima di creare il job. Non sono implementati Responses API, Assistants, tool/function calling, immagini, audio, più scelte, schema JSON, conteggi token o `stream_options`. Non viene pubblicato un endpoint server OpenAI in chiaro: la compatibilità risiede nell'adapter del browser.

## Vercel AI SDK: mantieni useChat e sostituisci il transport

Nel progetto React che usa `ai` e `@ai-sdk/react`:

```tsx
// LocalChat.tsx
'use client';

import { useMemo, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { PublicQueue, createUIMessageFetch, type Connection } from '@public-queue/sdk';

export function LocalChat({ connection, model }: { connection: Connection; model: string }) {
  const [input, setInput] = useState('');
  const transport = useMemo(() => new DefaultChatTransport({
    fetch: createUIMessageFetch(new PublicQueue(connection), {
      model,
      onJob: job => localStorage.setItem('last-local-job', job.id),
    }),
  }), [connection, model]);
  const { messages, sendMessage, status, error } = useChat({ transport });
  return <>
    {messages.map(message => <p key={message.id}>
      {message.parts.map(part => part.type === 'text' ? part.text : '').join('')}
    </p>)}
    {error && <p role="alert">{error.message}</p>}
    <form onSubmit={event => {
      event.preventDefault();
      if (input.trim()) { void sendMessage({ text: input }); setInput(''); }
    }}>
      <input value={input} onChange={event => setInput(event.target.value)} aria-label="Messaggio" />
      <button disabled={status === 'submitted' || status === 'streaming'}>Invia</button>
    </form>
  </>;
}
```

Mantieni stabile l'oggetto `connection` nel componente chiamante. L'adapter accetta messaggi UI con parti `text`; rifiuta parti tool/file/reasoning e body applicativi aggiuntivi invece di ignorarli. `metadata` dei messaggi è accettata ma non inviata al modello. Il ruolo `system` viene mantenuto.

L'integrazione è stata verificata con **OpenAI JS 7.19.0** e **AI SDK 7.0.107 / DefaultChatTransport** installati come dipendenze di test. L'adapter non richiede queste librerie come dipendenze runtime della SDK Public Queue. Il componente React è un esempio d'integrazione; non è stato collaudato visivamente nel browser.

## Disconnessioni, chiusura della scheda e ripresa

`onJob` comunica l'ID dopo l'accettazione persistente. Conservalo: ricaricare la pagina non deve chiamare nuovamente `submit` o `sendMessage` per lo stesso lavoro.

Per riprendere usa lo stesso client token e la stessa chiave IndexedDB del browser:

```ts
// resume.ts
import { PublicQueue, type Connection } from '@public-queue/sdk';

export async function resume(connection: Connection, jobId: string, show: (text: string) => void) {
  const queue = new PublicQueue(connection);
  let text = '';
  for await (const event of queue.stream(jobId)) {
    if (event.type === 'reset') text = '';
    else if (event.type === 'delta') text += event.text;
    else text = event.result.text; // risultato finale canonico
    show(text);
  }
}
```

Questo rilegge i blocchi correnti senza eseguire nuovamente il modello. Per evitare di rileggere blocchi già mostrati, conserva **insieme** testo parziale e `event.cursor`, e passa `queue.stream(jobId, { cursor })`. Il cursore contiene tentativo e sequenza. Non salvare solo il cursore se la UI perde il testo precedente.

Entrambi gli adapter supportano anche `{ resumeJobId: savedId }`: è una modalità **esplicita di replay**; il body della chiamata viene validato, ma non crea un nuovo prompt. Usa un'istanza dedicata per recuperare quel job e azzera/sostituisci la risposta parziale nella UI prima del replay. Non lasciare un adapter di replay configurato per l'invio di nuovi messaggi. Il `resume` automatico GET di `useChat` non è implementato da questo adapter: usa il percorso esplicito sopra.

La chiusura dello stream o `AbortSignal` interrompe l'osservazione, **non cancella il job**. Per interrompere anche il lavoro:

```ts
await queue.cancel(savedJobId);
```

Collega questa chiamata al tuo pulsante Stop se vuoi quella semantica; abortire soltanto la SDK OpenAI o il transport Vercel lascia il job recuperabile. La cancellazione sul runtime avviene al controllo del lease successivo ed è best effort.

## Quando l'inferenza riparte

Dopo perdita di lease, la coda può creare un nuovo tentativo. I blocchi sono legati crittograficamente a job, dispositivo, tentativo e sequenza. La SDK nativa emette `reset`: sostituisci il testo parziale.

Uno stream standard Chat Completions non sa ritirare testo già mostrato. Se aveva già emesso testo, l'adapter interrompe lo stream con `inference_restarted_resume_job` invece di mescolare tentativi. Recupera lo **stesso job** con il percorso di replay, sostituendo il testo precedente. Il job continua; non inviare nuovamente il prompt.

## Trasporto e limiti

- Runtime → agent: vero SSE progressivo. È richiesto un evento finale con `finish_reason` e `[DONE]`; uno stream troncato fallisce invece di diventare una risposta parziale “riuscita”.
- Agent → relay: POST di blocchi cifrati e numerati, salvati prima dell'ack; retry con identico ciphertext.
- Relay → browser: GET incrementali con cursore, circa ogni 500 ms per default. Non c'è SSE di rete dal relay in questa versione.
- Adapter → SDK della chat: `Response` con `ReadableStream` e formato SSE OpenAI oppure UI Message Stream Vercel. Non vengono inventati token dopo la fine di una risposta completa.
- Il batching dell'agent mira a circa 200 ms durante l'arrivo dei token; blocchi grandi vengono suddivisi. Non viene promesso aggiornamento per ogni singolo token.
- Massimo 2.048 blocchi e 2 MB cifrati per tentativo; blocco massimo 16 KiB, risultato testuale serializzato circa 900 KB. Lo stream SSE del runtime ha un tetto di lettura di 8 MB.
- Ogni job streaming riserva **4 MB** del budget payload, contro 2 MB di un job non streaming. Il tetto di job pendenti può quindi essere raggiunto prima dal budget storage.
- Browser disconnesso: il modello può continuare e il relay conserva i blocchi entro i limiti del piano. Stream abbandonati dal client non tengono aperta una connessione server per ore.

Il relay vede anche numero/dimensione/tempi dei blocchi e il fatto che un job sia streaming. La cifratura protegge il contenuto, non questi metadati.
