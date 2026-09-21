# Prodotto e monetizzazione

## Può funzionare?

Sì come prodotto per sviluppatori e piccoli team che possiedono già il calcolo e vogliono collegarlo a un'app web. L'ipotesi commerciale da validare è che siano disposti a pagare per pairing, identità, affidabilità e semplicità dell'integrazione. L'esistenza di tunnel gratuiti e workflow engine rende debole una proposta limitata a «accesso remoto a Ollama».

La promessa verificabile è: **invio un job dal mio sito, chiudo il browser, il computer torna online, recupero il risultato**. Evitare promesse di chat sempre disponibile quando l'hardware del cliente è spento.

## Cosa ha senso fare

- Un agent unico che usa il sottoinsieme comune delle API di inferenza. Configurazione locale dell'endpoint e dei modelli consentiti.
- Un SDK piccolo che nasconde cifratura, polling, retry e recupero del risultato. Esempio HTML senza framework.
- Associazione monouso, revoca dei dispositivi e credenziali distinte per client. I proprietari possono collegare frontend ospitati altrove.
- Coda e risultati persistenti, deadline, limite di concorrenza e tentativi identificati. Interfaccia chiara quando il dispositivo è offline.
- Cifratura E2E predefinita, con chiave del dispositivo verificata fuori dal relay. Non chiamarla semplicemente “encoding”.
- Hosting gestito di ciò che è scomodo da mantenere: storage, backup, TLS, quote, accesso e supporto.
- Distribuzione open source di SDK e agent, necessaria per ispezionare ciò che gira sulle macchine dei clienti.

## Cosa non fare inizialmente

- Marketplace di GPU, inferenza di sconosciuti sui computer dei clienti e promesse di uptime sui loro dispositivi.
- Download/modifica di modelli o esecuzione di tool, shell e file access attraverso la coda.
- Conteggio di token come fonte autoritativa per la fatturazione: con E2E l'operatore non vede contenuti e i contatori dell'agent non sono affidabili per billing avversariale.
- Un nuovo broker distribuito, Kafka, orchestrazione Kubernetes o microservizi prima di misurare un collo di bottiglia reale.
- Compatibilità completa con ogni estensione di ogni runtime. Rendere esplicito il contratto supportato.
- Una chiave segreta globale incorporata nel frontend. Login, credenziali personali o un backend di autorizzazione sono indispensabili per app condivise.
- “Nessun dato raggiunge il cloud”: il ciphertext e i metadati raggiungono il servizio.

## Come monetizzarlo

Il listino implementato è Free + Premium a **€29/anno**, con quote effettive per piano. Non sono previsti piani mensili, Team o Dedicated nel checkout corrente.

Vedi [MONETIZATION.md](MONETIZATION.md) per attivazione Stripe, quote, conti del margine e acquisizione dei primi clienti. Vedi [DEPLOYMENT.md](DEPLOYMENT.md) per Hetzner, SMTP, dominio e avvio operativo.
