# revo-flow

Mod Claude Code qui orchestre une demande avec une équipe de sous-agents, et montre l'avancement de chacun.

## Installation

Rien à télécharger : Claude Code récupère le dépôt tout seul depuis GitHub. Deux façons, au choix.

**Depuis une session Claude Code en terminal :**

```
/plugin install revo-flow --marketplace LilianMLG/revo-flow
```

Réponds `y` pour ajouter le marketplace, puis Entrée pour la portée **user**. Le mod est actif tout de suite.

**Depuis n'importe quel terminal (PowerShell, bash…), sans ouvrir Claude :**

```
claude plugin marketplace add LilianMLG/revo-flow
claude plugin install revo-flow@revo-flow
```

Dans les deux cas, le mod est ensuite chargé dans chaque nouvelle session, en terminal comme dans l'app desktop.

**Mise à jour :**

```
claude plugin marketplace update revo-flow
claude plugin update revo-flow@revo-flow
```

## Utilisation

```
/revo-flow <ta demande>
```

1. **Analyse** : le modèle de la session lit la demande et les specs. Le panneau affiche « En attente du plan d'exécution ».
2. **Plan** : il décide combien de sous-agents il faut (1 à 6), le modèle (Haiku, Sonnet, Opus) et l'effort de chacun, et la liste des tâches de chacun.
3. **Validation** : le plan s'affiche (agents, modèles, efforts, nombre de tâches) et attend **Lancer** ou **Annuler**, dans le dialogue ou avec les boutons du panneau. Aucun agent ne part avant. Annuler renvoie l'orchestrateur à la planification.
4. **Exécution** : les agents sont lancés. Chacun a sa barre de progression, de sa couleur, avec « n/total » et la tâche en cours. Un Agent lancé hors du plan n'est pas suivi.
5. **Fin** : l'orchestrateur vérifie le tout et fait la synthèse. Une notification donne la durée, le coût et le nombre de fichiers.

Sans `/revo-flow`, le mod ne fait rien.

| Commande | Effet |
| --- | --- |
| `/revo-flow <demande>` | lance un flow |
| `/revo-flow statut` | où en est chaque agent |
| `/revo-flow panneau` | affiche ou masque le panneau latéral |
| `/revo-flow stop` | arrête vraiment : les agents en cours (TaskStop) et le tour de l'orchestrateur, après confirmation, puis retire la barre et le panneau |

**Boutons du panneau** : **Lancer** / **Annuler** (validation du plan), **Arrêter** sur chaque agent en cours, **Tout arrêter**, et **Relancer** sur un agent en échec : il repart de ses tâches non terminées et l'orchestrateur le relance. Le panneau s'adapte aussi au mobile.

**Tokens et contexte** : en terminal, la ligne de fin de tour (« Baked for… ») devient `⏱ durée · tokens in · out · cache · coût · modèle`. La barre au-dessus du prompt ajoute une 2e ligne avec le dernier prompt et `ctx n %`, et le panneau a une jauge de contexte. Après une compaction, le rôle d'orchestrateur et l'état des agents sont réinjectés.

## Options (`/config`)

| Option | Défaut | Effet |
| --- | --- | --- |
| `validerPlan` | oui | demande « Lancer » ou « Annuler » avant de lancer les agents ; sans personne à qui demander (`claude -p`), le plan part tout seul |
| `conflits` | `avertir` | fichier déjà modifié par un autre agent encore au travail : `avertir` affiche un toast, `refuser` bloque la modification |
| `notifier` | oui | notification système à la fin d'un flow et quand un agent échoue (un toast si elle ne peut pas partir) |

Sur l'app desktop, `/revo-flow` n'apparaît pas toujours dans le menu `/` : tape la commande en entier, elle fonctionne.

## Développement

```
claude plugin validate .
claude plugin test .
```
