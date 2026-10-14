# 📚 Compta Coffrets — mode d'emploi

Un tableau de bord qui recalcule **ta vraie TVA** à partir de tes commandes Shopify,
sans faire confiance aux taux appliqués par Shopify.

## Ce qu'il y a dans le dossier

| Fichier | Rôle |
|---|---|
| `dashboard.html` | Le tableau de bord : double-clique pour l'ouvrir dans ton navigateur |
| `tva.js` | Les règles de calcul de la TVA (ne pas déplacer, utilisé par le dashboard) |
| `sync_shopify.py` | Synchro automatique avec Shopify : crée/actualise `data.js` (chiffré) |
| `.env.example` | Modèle pour tes identifiants Shopify |
| `exemple_commandes.csv` | Fausses commandes pour essayer le dashboard |
| `.github/workflows/mise-en-ligne.yml` | Le robot GitHub qui met le site à jour chaque nuit |

## 🔒 Sécurité

- Au premier lancement, le dashboard te demande de **créer un mot de passe** (8 caractères minimum).
- Toutes les données enregistrées dans ton navigateur (commandes importées, réglages, checklists)
  sont **chiffrées** avec ce mot de passe (AES-256-GCM, clé dérivée par PBKDF2 avec 600 000 itérations).
  Sans le mot de passe, elles sont illisibles.
- Le fichier `data.js` créé par la synchro est chiffré de la même façon : utilise **le même mot de passe**.
- Le dashboard se **verrouille tout seul après 15 minutes** d'inactivité, ou avec le bouton 🔒.
- Le mot de passe n'est enregistré nulle part : **si tu l'oublies, les données sont perdues**. Il faudra
  tout effacer, réimporter tes CSV et relancer la synchro. Note-le dans un gestionnaire de mots de passe.
- Le fichier `.env` contient la clé de ton application Shopify, en clair : le script le rend lisible
  par toi seule. Ne l'envoie jamais à personne et ne le mets pas sur un drive partagé.
- Les fichiers CSV exportés depuis Shopify ne sont pas chiffrés : supprime-les après l'import.
- Les données sont liées au navigateur utilisé : ouvre toujours le dashboard avec le même.

## La vue principale (filtrable par dates)

Choisis une période avec les raccourcis (ce mois, trimestre, année…) ou les dates « Du / Au ».
Pour une déclaration, prends exactement ta période de déclaration.

- 🎁 **La Totale** et 📖 **L'Essentiel** : nombre vendu, montant brut TTC, frais bancaires, net après frais.
- **Chiffre d'affaires**, **remboursements** (nombre et montant), **frais bancaires et Shopify**, **net encaissé**.
- **Par moyen de paiement** : PayPal et Shopify Payments, avec le détail par coffret.
- **TVA à déclarer** : par taux, avec les lignes de la déclaration CA3.

Les **frais bancaires** :
- Shopify Payments : frais réels quand ils viennent de la synchro API.
- PayPal et import CSV : **estimés** avec le barème des Réglages (1,5 % + 0,25 € pour Shopify Payments,
  2,9 % + 0,35 € pour PayPal par défaut). **Vérifie ces taux sur tes contrats** et corrige-les.
- Abonnement Shopify et applis : à indiquer en €/mois dans les Réglages, réparti sur la période choisie.

## Comment la TVA est calculée

| | Prix TTC | Livre 5,5 % | Goodies 20 % |
|---|---|---|---|
| Coffret La Totale | 49 € | 35 € (TVA 1,82 €) | 14 € (TVA 2,33 €) |
| Coffret L'Essentiel | 35 € | 35 € (TVA 1,82 €) | — |

- **Remises** : réparties entre livre et goodies dans les mêmes proportions (35/49 et 14/49).
- **Frais de port** : ils suivent la TVA des produits expédiés. Pour L'Essentiel, tout le port est
  à 5,5 %. Pour La Totale, 35/49 du port est à 5,5 % et 14/49 à 20 %.
  Exemple : port à 13,90 € → 9,93 € à 5,5 % + 3,97 € à 20 %.
- **Remboursements** : retirés de la commande au prorata.
- **Commandes annulées** : ignorées.

Tu peux modifier les prix, les taux ou ajouter un coffret via le bouton **⚙︎ Mes coffrets**.
Un produit est reconnu si son nom dans Shopify contient le mot-clé (« totale », « essentiel »).

## Option 1 — Import CSV (aucune installation)

1. Shopify → **Commandes** → **Exporter** → « Toutes les commandes » ou une période → **CSV pour Excel**.
2. Ouvre `dashboard.html` → **Importer un export CSV Shopify** → choisis le fichier.
3. Les imports s'ajoutent les uns aux autres (une commande déjà importée est remplacée, pas doublée).

## Option 2 — Synchro automatique avec Shopify

Depuis le 1er janvier 2026, Shopify ne permet plus de créer d'« applications personnalisées »
dans l'admin : il faut passer par le **Dev Dashboard**.

1. Va sur le Dev Dashboard Shopify (dev.shopify.com) et crée une application.
2. Dans **Versions**, donne-lui les accès `read_orders` (et `read_all_orders` pour les commandes
   de plus de 60 jours), puis publie la version.
3. Installe l'application sur ta boutique (onglet **Home**).
4. Dans **Settings**, copie le *Client ID* et le *Client secret*.
5. Copie `.env.example` en `.env` et remplis-le **toi-même** (ne partage jamais ce fichier).
6. Installe la bibliothèque de chiffrement (une seule fois) :

   ```bash
   python3 -m pip install cryptography
   ```
7. Dans un terminal, depuis ce dossier, lance la synchro. Elle te demande le mot de passe du dashboard :

   ```bash
   python3 sync_shopify.py
   ```

   Pour récupérer depuis une autre date : `python3 sync_shopify.py 2025-01-01`
8. Recharge `dashboard.html`. La ligne en haut indique la date de la dernière synchro.

Si tu as déjà une ancienne application avec un jeton `shpat_…`, tu peux le mettre dans
`SHOPIFY_ACCESS_TOKEN` à la place.
La synchro récupère aussi les **frais Shopify Payments** quand Shopify les fournit.
Les frais PayPal restent dans ton relevé PayPal.

## 🌐 Version en ligne (mise à jour automatique chaque nuit)

Le code est sur GitHub. Chaque nuit, GitHub Actions lance la synchro, chiffre les commandes avec
ton mot de passe et publie le tableau de bord sur GitHub Pages. Les données ne sont jamais
enregistrées dans le dépôt, seulement dans le site publié, et toujours chiffrées.

- Pour lancer une mise à jour tout de suite : onglet **Actions** → « Synchro Shopify et mise en ligne » → **Run workflow**.
- Les identifiants sont dans **Settings → Secrets and variables → Actions** : `SHOPIFY_STORE`,
  `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_TEST_NAMES`, `DASHBOARD_PASSWORD`.
- Le mot de passe du site doit être **long (12 caractères ou plus)** : le fichier chiffré est téléchargeable.
- GitHub met en pause les tâches automatiques d'un dépôt public sans activité depuis 60 jours.
  Il envoie un e-mail : il suffit alors de cliquer sur **Enable workflow** dans l'onglet Actions.
- Les réglages et checklists sont enregistrés dans chaque navigateur : à refaire sur le téléphone.

## 🧪 Commandes test

Les commandes aux noms indiqués dans `SHOPIFY_TEST_NAMES` (fichier `.env`) ou dans ⚙︎ Réglages sont repérées par 🧪 « test ? » dans la liste.
- Une case en haut de la page permet de les **exclure** des totaux, de la TVA et de l'export comptable.
- La case 🧪 au début de chaque ligne permet de marquer ou démarquer une commande à la main.
- Les noms à surveiller se changent dans ⚙︎ Réglages → Commandes test.
- Les commandes test annulées ou entièrement remboursées comptent déjà pour 0 €.

## Le côté ludique

- 🐷 **Tirelire TVA** : le montant à mettre de côté pour la période choisie.
- ✅ **Checklist** par période (mémorisée dans ton navigateur).
- 🏆 **Trophées** débloqués selon tes ventes.
- ⚠️ **Écart Shopify** : montre combien Shopify s'est trompé.

## À vérifier avec ton expert-comptable

- La répartition du port au prorata est la règle habituelle pour un colis à plusieurs taux de TVA.
  Fais-la valider une fois.
- Les numéros de ligne CA3 (01, 08, 09, 16) sont indicatifs : vérifie-les sur ton formulaire.
- Ventes hors de France (signalées ⚠️) : au-delà de 10 000 € par an de ventes à des particuliers
  dans l'UE, c'est la TVA du pays de livraison qui s'applique (guichet OSS).
- Le dashboard calcule la TVA **collectée**. Ta TVA **déductible** (achats) reste à ajouter.
- Les factures émises par Shopify restent fausses tant que les taxes Shopify ne sont pas corrigées.
  Le détail d'une commande dans le dashboard montre la ventilation correcte à reporter.
