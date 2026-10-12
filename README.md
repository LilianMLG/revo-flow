# revo-flow

Mod Claude Code qui orchestre une demande avec une équipe de sous-agents, et montre l'avancement de chacun.

## Installation

Dans une session Claude Code **en terminal** :

```
/plugin install revo-flow --marketplace LilianMLG/revo-flow
```

Réponds `y` pour ajouter le marketplace, puis choisis la portée **user** (Entrée). Le mod est actif tout de suite, et dans chaque nouvelle session, terminal comme app desktop.

Mise à jour : `/plugin marketplace update revo-flow`, puis `/reload-plugins`.

## Utilisation

```
/revo-flow <ta demande>
```

1. **Analyse** : le modèle de la session lit la demande et les specs. Le panneau affiche « En attente du plan d'exécution ».
2. **Plan** : il décide combien de sous-agents il faut (1 à 6), le modèle (Haiku, Sonnet, Opus) et l'effort de chacun, et la liste des tâches de chacun.
3. **Exécution** : les agents sont lancés. Chacun a sa barre de progression, de sa couleur, avec « n/total » et la tâche en cours.
4. **Fin** : l'orchestrateur vérifie le tout et fait la synthèse.

Sans `/revo-flow`, le mod ne fait rien.

| Commande | Effet |
| --- | --- |
| `/revo-flow <demande>` | lance un flow |
| `/revo-flow statut` | où en est chaque agent |
| `/revo-flow panneau` | affiche ou masque le panneau latéral |
| `/revo-flow stop` | retire la barre et le panneau |

Sur l'app desktop, `/revo-flow` n'apparaît pas toujours dans le menu `/` : tape la commande en entier, elle fonctionne.

## Développement

```
claude plugin validate .
claude plugin test .
```
