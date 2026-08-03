# Fork Pi avec opérations durables

Ce fork ajoute une couche de persistance et de reprise au CLI Pi existant. Il
conserve la boucle agent, les outils, les extensions, les sessions et les modes
TUI/print/RPC de Pi, puis journalise chaque opération autour de
`AgentSession`.

Le fork est maintenu sur :

- `origin` : `https://github.com/alertemikope/pi.git`
- `upstream` : `https://github.com/earendil-works/pi.git`

## Portée exacte

Cette implémentation n'est pas encore le Harness v2 complet décrit dans
[`packages/agent/docs/harness-v2.md`](packages/agent/docs/harness-v2.md).
Le fork intègre toutefois désormais le premier backend expérimental upstream :
`SessionRepo`, le schéma des entrées et records, les lanes, le journal global,
le backend mémoire et sa suite de conformité. Le runtime coding-agent reste
temporairement adossé à son sidecar durable pendant la migration vers ce
nouveau contrat.

Le fork ajoute dès maintenant les propriétés suivantes au coding agent :

- une opération durable par requête utilisateur dans chaque session
  persistante ;
- les états `accepted`, `running`, `suspended`, `completed`, `failed` et
  `aborted` ;
- des checkpoints pour les requêtes provider, les résultats d'outils et les
  fins de tour ;
- un suivi des effets d'outils avec identité déterministe par
  `operationId + assistantEntryId + toolIndex` et hash des arguments ;
- un cycle de vie explicite `reserved`, `dispatched`, `completed`, `failed` et
  `unresolved`, qui distingue un outil connu comme non exécuté d'un effet dont
  l'issue externe est incertaine ;
- la détection d'une opération interrompue au prochain démarrage ;
- le classement d'un effet dispatché en `unresolved` après une interruption ;
- la réutilisation du résultat uniquement pour la même occurrence persistée
  d'appel d'outil, jamais par simple ressemblance du nom et des arguments ;
- la persistance du lot de messages préparé et du system prompt réellement
  utilisé, après les hooks d'extension ;
- des événements publics passifs : chaque abonné reçoit sa propre copie et ne
  peut ni muter l'entrée envoyée au provider, ni interrompre l'opération ;
- la réconciliation idempotente des résultats d'outils manquants avant une
  reprise ;
- un verrou d'écriture exclusif par session pour empêcher deux processus de
  modifier le même journal ;
- une ouverture stricte des sessions existantes et une publication différée
  des forks/imports jusqu'à l'acquisition du verrou ;
- une reprise opérateur avec `/recover` et un abandon avec
  `/recover abort`.
- des receipts de vérification exécutés par le host, avec commande, cwd,
  terminaison typée, hashes complets et extraits bornés de stdout/stderr ;
- une classification structurée des erreurs assistant avec type, caractère
  rejouable et action de récupération (`wait`, `compact`, `reauthenticate`,
  `change_model`, etc.).

Cette couche ne fournit pas encore les primitives complètes prévues par le
design Harness v2 : `AgentHarness.create`, ordonnanceur de lanes, abonnements
`watch`, stockage JSONL/SQLite v4 ou reprise exacte record-by-record de la
génération du modèle.

## Avancement des trois phases

### Phase 1 — durabilité

Implémenté :

- backend mémoire et suite de conformité Harness v2 ;
- `StepAttemptRecord.resultEntryId` et ledger `UsageRecord` alignés sur le
  design final ;
- séparation durable réservation/dispatch/settlement des outils ;
- refus d'abandonner un effet externe non réconcilié.

Restant : diagnostics de sortie processus, reaper fail-closed, contrats de
capacités persistés pour les subagents et vrais tests de crash par processus.

### Phase 2 — fiabilité coding

Implémenté : résultat processus discriminé, receipts de vérification
host-attested persistés dans l'opération active et API
`registerVerificationCheck()` permettant aux extensions de déclarer une
politique sans pouvoir fabriquer elles-mêmes la preuve. Un check en échec fait
échouer l'opération avant son settlement.

Restant : correction automatique bornée après un check en échec, snapshots Git
par opération, transactions de workspace et isolation worktree des lanes. Ces
politiques resteront des extensions construites sur les primitives core.

### Phase 3 — performance et observabilité

Implémenté : ledger de coût Harness v2 et taxonomie structurée des échecs avec
actions de récupération.

Restant : comparaison du payload provider pour mesurer la stabilité du
préfixe, journal de production séquencé, offsets durables des consommateurs et
stockage CAS des payloads volumineux.

## Journal

Pour une session persistée dans :

```text
<session-file>
```

Pi crée un journal séparé :

```text
<session-file>.operations.jsonl
```

Le transcript v3 upstream n'est donc pas modifié et reste lisible par Pi
upstream. Le journal JSONL est append-only, utilise le schéma `1`, et
reconstruit l'état des opérations au chargement. Une dernière ligne JSON
partiellement écrite est supprimée ; un record complet invalide ou une
corruption ailleurs arrête le chargement au lieu de masquer la perte de
données. L'état réduit est ensuite conservé en mémoire : Pi ne reparcourt pas
le journal complet à chaque appel d'outil.

Lorsqu'une session est ouverte par le runtime, Pi crée également :

```text
<session-file>.operations.jsonl.lock/
```

Le verrou est atomique. Un second Pi, T3 ou daemon ne peut pas déclarer à tort
que le premier processus a crashé ni écrire simultanément dans le journal. Un
verrou dont le PID n'existe plus est récupéré au prochain chargement. Il est
libéré lors de la fermeture normale de `AgentSession`.

Le lease transféré au runtime est lié au chemin canonique du journal et ne peut
être consommé qu'une fois. Les changements de session préparent et valident la
cible avant de fermer la session courante. Un import portant le même nom qu'une
session existante reçoit un nouveau chemin au lieu d'écraser la cible.

Le dossier est créé avec le mode `0700` et le fichier avec le mode `0600`
lorsque le système de fichiers prend en charge les permissions POSIX.

Le journal contient notamment le prompt, les messages préparés, le system
prompt, les réservations et dispatchs d'outils, leurs résultats finaux après
hooks, les erreurs et les receipts de vérification. Il doit être protégé comme
le fichier de session lui-même et ne doit pas être publié sans vérification.
Supprimer une session depuis le sélecteur Pi supprime ou met à la corbeille son
sidecar exact ; les sidecars sont exclus de la liste des sessions.

Les sessions en mémoire ne créent pas de journal et ne proposent pas la
reprise durable.

## Reprise après interruption

Si Pi s'arrête avant le checkpoint terminal, l'opération active devient
`suspended` au prochain chargement de la session. Un outil seulement réservé
reste `reserved` et est connu comme non exécuté. Un outil dispatché sans
résultat enregistré devient `unresolved`, car Pi ne peut pas savoir si l'effet
externe a eu lieu avant l'arrêt.

Dans le TUI :

```text
/recover
```

relance une nouvelle tentative du modèle avec une consigne de récupération :
inspecter la session et l'état réel du projet avant de continuer, puis éviter
de répéter un effet externe incertain.

Avant cet appel, Pi restaure le lot de messages et le system prompt préparés.
Il vérifie aussi chaque appel d'outil déjà visible dans le transcript. Si le
résultat final manque, Pi réinjecte exactement une entrée `toolResult` :

- le résultat final journalisé pour un effet terminé ;
- une erreur synthétique indiquant qu'aucun effet n'a eu lieu pour une
  réservation interrompue, ou demandant une inspection pour un effet
  `unresolved`.

Le transcript est écrit avant le record d'acquittement. Un second crash entre
les deux ne duplique donc pas le résultat lors de la prochaine reprise.

Pour abandonner l'opération suspendue :

```text
/recover abort
```

L'abandon restaure également l'entrée préparée et réconcilie les appels
d'outils interrompus avant d'écrire l'état `aborted`. Si cette réconciliation
échoue, l'opération reste `suspended` et un nouveau prompt demeure bloqué.

La politique de reprise est volontairement conservatrice :

- le journal sait distinguer un appel `read` rejouable d'un outil de mutation,
  mais `/recover` ne relance automatiquement aucun effet interrompu ;
- le chemin normal réconcilie un appel interrompu avec un résultat synthétique,
  puis le modèle peut décider d'émettre un nouvel appel `read` après inspection ;
- les outils de mutation et les outils d'extension sont marqués non rejouables
  par défaut ;
- un effet terminé peut rendre son résultat journalisé sans être exécuté une
  seconde fois uniquement si son occurrence persistée, son outil et ses
  arguments sont identiques ;
- deux appels distincts avec les mêmes arguments restent deux effets
  légitimes ;
- un effet `unresolved` reçoit un résultat synthétique et demande une
  inspection de l'état courant avant toute nouvelle mutation.

La reprise ne constitue ni un rollback, ni une transaction du système de
fichiers, ni une preuve qu'un effet distant a réussi. Elle protège
principalement contre les doubles effets après un arrêt de processus. Le
journal n'appelle pas `fsync`, donc il ne garantit pas la conservation du
dernier record après une panne machine ou une coupure de courant.

`/recover` est actuellement exposé dans le TUI et par les méthodes publiques
`AgentSession.resumeSuspendedOperation()` /
`AgentSession.abortSuspendedOperation()`. Les modes print et RPC ne disposent
pas encore d'une commande dédiée.

## Installation depuis le fork

Prérequis : Git, Node.js `>=22.19.0` et npm.

```bash
git clone https://github.com/alertemikope/pi.git
cd pi
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm link --ignore-scripts --workspace @earendil-works/pi-coding-agent
```

La commande `npm link` fait pointer le binaire global `pi` vers ce checkout.
Le lien reste valide après les reconstructions suivantes.

Vérifier l'installation :

```bash
pi --version
command -v pi
ls -l "$(command -v pi)"
```

Le numéro de version suit encore la version upstream et ne suffit donc pas à
identifier le fork. La cible du lien et le commit Git sont la source de vérité :

```bash
git -C /chemin/vers/pi rev-parse HEAD
```

Les réglages, authentifications, sessions et extensions restent dans les
emplacements Pi habituels, notamment `~/.pi/agent/`.

## Mise à jour depuis upstream sans perdre les patchs

Ne remplacez pas la branche du fork par `upstream/main` et n'utilisez pas
`git reset --hard`. Intégrez upstream dans une branche dédiée, validez le
résultat, puis fusionnez cette branche dans le fork.

Ajouter le remote upstream une seule fois si nécessaire :

```bash
git remote get-url upstream >/dev/null 2>&1 ||
  git remote add upstream https://github.com/earendil-works/pi.git
```

Préparer une mise à jour :

```bash
git fetch origin
git fetch upstream
git switch main
git pull --ff-only origin main
git switch -c agent/sync-upstream-YYYYMMDD
git merge --no-ff upstream/main
```

En cas de conflit, il faut adapter les fichiers durables au nouveau runtime ;
ne choisissez pas automatiquement la version `ours` ou `theirs`. Les points
d'intégration à contrôler en priorité sont :

```text
packages/coding-agent/src/core/agent-session.ts
packages/coding-agent/src/core/durable-operations.ts
packages/coding-agent/src/core/slash-commands.ts
packages/coding-agent/src/modes/interactive/interactive-mode.ts
```

Après la fusion :

```bash
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm run check
./test.sh
node packages/coding-agent/dist/cli.js --version
node packages/coding-agent/dist/cli.js --help
```

Si les contrôles passent, publier la branche et la fusionner par pull request :

```bash
git push -u origin agent/sync-upstream-YYYYMMDD
```

Après fusion dans `main`, reconstruire le checkout utilisé par le lien global :

```bash
git switch main
git pull --ff-only origin main
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
hash -r
```

Cette procédure conserve l'historique du patch durable et rend les conflits
upstream visibles avant qu'ils n'affectent le binaire `pi` utilisé au
quotidien.
