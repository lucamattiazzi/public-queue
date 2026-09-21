# Vendere Public Queue

## L'offerta implementata

**Free + Premium a €29/anno, rinnovo annuale.** Circa €2,42/mese, senza addebito mensile. Il cliente paga disponibilità del relay, persistenza, pairing, integrazione e gestione dell'infrastruttura. Il calcolo e i modelli sono suoi. Non vendere token né “inferenza illimitata”. L'E2E è inclusa anche nel Free.

| | Free | Premium |
|---|---:|---:|
| Dispositivi | 1 | 3 |
| Connessioni client | 3 | 20 |
| Job accettati/mese UTC | 500 | 10.000 |
| Job/giorno / pendenti | 50 / 8 | 1.000 / 100 |
| Deadline massima / retention risultati | 1 giorno | 7 giorni |
| Budget payload | 16 MiB | 256 MiB |

Le quote sono nel backend, non soltanto nella pagina prezzi. Un account ha un workspace. La scadenza predefinita del job è 24 ore anche su Premium; il client può richiederne fino a sette giorni. Non promettere supporto sincrono individuale compreso in €29/anno.

## Come iniziare a incassare

1. Attiva il tuo account Stripe con dati dell'attività e conto per gli accrediti. Questa integrazione usa Stripe Payments + Billing, non un servizio merchant-of-record. Definisci con il commercialista il trattamento IVA/fatturazione della tua attività e dei mercati serviti; la generazione di una fattura Stripe non dimostra, da sola, di aver assolto tutti gli adempimenti italiani.
2. In **test mode**, crea il prodotto `Public Queue Premium`, prezzo ricorrente **EUR 29,00 / anno**, quantità 1, **tax behavior inclusive**. Non configurare trial, prezzi a consumo o coupon per questo primo lancio. Copia `price_...` in `PQ_STRIPE_PRICE_ID`. L'app verifica importo, valuta, periodicità e inclusione imposte prima del checkout.
3. Imposta `PQ_STRIPE_SECRET_KEY` e crea l'endpoint webhook `https://TUO-DOMINIO/v1/billing/webhook`. Copia il signing secret in `PQ_STRIPE_WEBHOOK_SECRET`. Usa gli eventi `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Preferisci la versione API `2026-08-26.dahlia` usata dall'SDK bloccato nel lockfile, ricontrollandola quando aggiorni Stripe.
4. Nel Customer Portal abilita consultazione fatture, aggiornamento metodo di pagamento e cancellazione **a fine periodo**. Disabilita cambi di piano/prezzo/quantità: questo prodotto ne supporta uno solo. Attiva i messaggi Stripe per pagamento fallito e rinnovo secondo la tua policy.
5. Per calcolare automaticamente le imposte configura codice fiscale del prodotto e registrazioni fiscali in Stripe Tax, quindi `PQ_STRIPE_AUTOMATIC_TAX=true`. Se lo lasci disabilitato, devi avere una motivazione/configurazione fiscale appropriata: il software non calcola né versa IVA per magia. Mantieni €29 come totale esposto, assorbendo le imposte applicabili nel prezzo.
6. Completa un acquisto di test dal tuo `/app/`. Verifica attivazione tramite webhook, replay dello stesso evento, ritorno senza pagamento, portale, cancellazione, scadenza e pagamento fallito. Il test automatico di firma usa l'SDK reale, ma **non sostituisce un acquisto Stripe di test**.
7. Ripeti prodotto/prezzo, portale ed endpoint nella modalità live. Sostituisci insieme le tre variabili con quelle live e riavvia. Nessuna chiave segreta deve finire nel frontend. I primi utenti possono ora pagare senza provisioning manuale.

Il backend crea Checkout sul server, associa un Customer a un account verificato, riusa richieste concorrenti tramite idempotenza e attiva Premium solo dopo un evento firmato e una verifica dello stato attuale su Stripe. Gli eventi duplicati non raddoppiano nulla; un evento vecchio non ripristina il vecchio stato. In caso di webhook fallito, risolvi l'errore e reinvia l'evento dalla dashboard Stripe. La scadenza locale evita accesso pagato perpetuo quando manca una notifica; non sostituisce il monitoraggio dei rinnovi.

I rimborsi si gestiscono in Stripe: se vuoi anche terminare l'accesso, cancella la subscription. Il solo rimborso di un pagamento non cancella automaticamente un abbonamento. La cancellazione dall'account termina gli abbonamenti immediatamente prima di eliminare i dati locali. I documenti finanziari restano soggetti alla retention di Stripe e agli obblighi dell'operatore.

## Margine: numeri realistici

Alla verifica del 20 settembre 2026, il listino italiano Stripe indica **1,5% + €0,25** per carte SEE standard e **0,7%** del volume per Billing; Tax via integrazione può aggiungere **0,5%** quando applicabile. Altre carte, cambi, contestazioni e servizi hanno tariffe diverse. [Listino ufficiale](https://stripe.com/it/pricing).

Esempio puramente aritmetico su €29, carta SEE standard, Billing a consumo, senza Tax e senza altre commissioni:

- Pagamento: €0,685; Billing: €0,203; totale circa **€0,89**.
- Rimangono circa **€28,11/anno** prima di imposte, server, email, backup, assistenza e rimborsi.
- Nell'ipotesi esemplificativa che il totale includa il 22% di IVA da versare: imponibile €23,77, meno le commissioni sopra ≈ **€22,88/anno**, prima degli altri costi. Non è un'affermazione sull'aliquota applicabile alla tua attività.

Con costi fissi ipotizzati di €15/mese, €180/anno / €22,88 ≈ **8 clienti paganti** coprono solo quei costi; con €30/mese ne servono circa **16**. Il server già esistente non rende gratuiti tempo, rischio e supporto. Cento clienti sono €2.900/anno di incassi lordi: un piccolo prodotto, non ancora uno stipendio.

## Vendere davvero, senza confondere billing e domanda

Inizia con una demo di 60–90 secondi: frontend statico → job salvato → computer offline → riaccensione → risultato nello stesso job. Il beneficio è concreto e differisce da un semplice tunnel.

Acquisisci i primi 10 utenti fra sviluppatori con Ollama/LM Studio che abbiano già un sito o prototipo. Pubblica esempi copiabili per HTML e React, una guida per ogni runtime realmente verificato e il codice di agent/SDK. Prima valida cinque utilizzi reali ripetuti, poi proponi Premium a chi raggiunge limiti o collega altri dispositivi. Non presentare download o stelle come ricavi.

Misura: iscritti verificati → dispositivo associato → primo risultato reale → uso dopo sette giorni → acquisto. Tieni anche tempo di onboarding, minuti di assistenza per cliente, errori job, storage e traffico. Obiettivo iniziale da validare: primo risultato in meno di cinque minuti, con runtime già acceso e modello disponibile. Nessun tracker pubblicitario è stato aggiunto; i contatori operativi non includono il testo dei prompt.

Evita lifetime a prezzo basso e piani “illimitati”. Se l'assistenza assorbe il margine, migliora pairing/documentazione o restringi il supporto prima di alzare la complessità. Team e istanze dedicate hanno senso solo dopo richieste reali: non sono implementati né pubblicizzati come disponibili.

## Fonti operative

- [Stripe: webhook delle subscription](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe: verifica firme e gestione webhook](https://docs.stripe.com/webhooks)
- [Stripe: portale clienti](https://docs.stripe.com/customer-management)
- [Stripe Tax](https://docs.stripe.com/tax)

Il sito può vendere dopo configurazione, verifica dei servizi reali e completamento delle informazioni dell'operatore. La presenza del codice non dimostra disponibilità di clienti paganti.
