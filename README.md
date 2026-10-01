# SOMA Events — suivi des invités

Application web statique (GitHub Pages) de gestion des invités aux événements SOMA.

**Ce dépôt est public et ne contient aucune donnée.** Les données (événements, invités) sont dans un dépôt
GitHub **privé** séparé (`soma-events-data`), lu et écrit directement depuis le navigateur via l'API GitHub avec
un token personnel. Sans token autorisé sur ce dépôt privé, la page n'affiche rien.

## Fonctionnalités
- Plusieurs événements (sélecteur + création, avec reprise de la liste d'un événement précédent)
- Statuts : À inviter · Invité · Confirmé · Peut-être · Absent, case « invitation envoyée », commentaires
- Enregistrement automatique (un commit par modification groupée dans le dépôt privé)
- Export Excel, import Excel (fusion ou remplacement) et modèle d'import
- Message d'invitation personnalisable par événement (`{prenom}`, `{nom}`, `{societe}`, `{signature}`)
- Par invité : mail pré-rempli (mailto) ou brouillon Outlook `.eml` avec l'invitation agenda `.ics` ; zip de tous les brouillons
- « Copier la liste » formatée pour WhatsApp ou Teams (présents / peut-être / absents / sans réponse)
- Bases de contacts (CSV/Excel) importées **localement dans le navigateur** (IndexedDB, jamais envoyées) :
  recherche à l'ajout d'un invité et complétion des emails manquants

## Accès
1. Créer un [fine-grained token](https://github.com/settings/personal-access-tokens/new) :
   *Only select repositories* → `soma-events-data`, permission **Contents : Read and write**.
2. Ouvrir la page GitHub Pages, saisir le dépôt `dbamba-soma/soma-events-data` et le token.

La page refuse de fonctionner sur un dépôt de données public.
