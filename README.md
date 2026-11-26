# I324 – S4 – Livrer

L'application de tâches passe le linter et les tests à chaque push. Il reste à la **livrer** : la mettre dans une image que n'importe quel serveur peut lancer, la publier, et ne jamais livrer une dépendance qui a une faille connue.

Chaque demande arrive comme un besoin de l'équipe. À vous de trouver comment y répondre. Après chaque push, la CI tourne, puis un **bot** vérifie votre travail et vous répond par e-mail avec la demande suivante.

Dans tout le parcours, `<pseudo>` est votre nom d'utilisateur GitHub **en minuscules**.

## Avant de commencer

Si votre PC n'est pas encore prêt (Git, Node.js, Docker Desktop, identité Git, notifications), suivez d'abord [INSTALLATION.md](INSTALLATION.md).

## Mission 1 : rejoindre l'équipe

1. **Vérifier Docker** : Docker Desktop doit être lancé (icône de la baleine). Dans un terminal :
   ```
   docker run hello-world
   ```
2. **Cloner** le dépôt dans VS Code (`Ctrl+Shift+P` › **Git: Clone**), avec l'adresse donnée par l'enseignant, puis lancer `npm install`.
3. **Créer votre branche** `livrer/<pseudo>` à partir de `origin/main` : en bas à gauche, cliquez sur le nom de la branche › **Create new branch from...** › `origin/main`.
4. **Créer votre fichier de réponses** `reponses/<pseudo>.md` :
   ```
   # Réponses de <pseudo>

   q1: la première phrase affichée par docker run hello-world
   q2:
   q3:
   q4:  
   ```
5. **Commit** avec le message `docs: ajoute ma fiche de réponses`, puis **Publish Branch**.

Le bot vous répond quand la CI de votre push est terminée (1 à 2 minutes), par e-mail.

## Règles du jeu

- Vous travaillez uniquement sur `livrer/<pseudo>`.
- Le workflow de l'équipe est `.github/workflows/ci.yml`, il s'appelle `CI` : gardez ce nom.
- Ne modifiez pas `bot.yml` ni `nettoyage.yml`.
- Pas de réponse du bot deux minutes après la fin de la CI ? Regardez l'onglet **Actions**, puis demandez à l'enseignant.

---

Application d'origine : [docker/getting-started-app](https://github.com/docker/getting-started-app), licence MIT.
