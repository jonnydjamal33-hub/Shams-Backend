# Shams Mobile API

API Express/MongoDB consommée par l'application Flutter du dossier `shams`.

## Démarrage local

Prérequis : Node.js 20+ et MongoDB local ou Atlas.

```powershell
cd backend-shams
npm install
Copy-Item .env.example .env
```

Renseignez `MONGODB_URI` et remplacez `JWT_SECRET` par une valeur aléatoire longue dans `.env`, puis lancez :

```powershell
npm run dev
```

L'API écoute sur `http://localhost:5000`. Vérifiez `GET /health`.

L'émulateur Android joint l'hôte avec `http://10.0.2.2:5000` (URL Flutter par défaut). Pour un téléphone physique, utilisez l'adresse IP LAN de l'ordinateur; pour iOS/web, utilisez `http://localhost:5000`.

```powershell
cd shams
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:5000
```

## Déploiement Render

Le fichier `render.yaml` à la racine du dépôt configure le service Node, le health check `/health` et un disque persistant monté sur `/var/data` pour les uploads. Le disque exige une instance Render payante; sans disque, les photos peuvent être perdues lors d'un redéploiement ou redémarrage.

1. Poussez le dépôt sur GitHub et créez un Blueprint Render en sélectionnant ce dépôt et son `render.yaml`.
2. Renseignez `MONGODB_URI` avec l'URI MongoDB Atlas. Configurez l'accès réseau Atlas pour permettre les connexions sortantes Render.
3. Définissez `CORS_ORIGINS` comme une liste de domaines web HTTPS séparés par des virgules; utilisez `*` uniquement si l'accès navigateur depuis toutes origines est voulu. Pour une app mobile native seule, une liste vide convient.
4. Configurez `ADMIN_BOOTSTRAP_EMAIL` et `ADMIN_BOOTSTRAP_PASSWORD` comme variables secrètes Render (mot de passe d'au moins 16 caractères). Au démarrage, le backend crée ce compte admin s'il n'existe pas, ou approuve le compte existant de cette adresse. Le mot de passe bootstrap n'est défini que pour un nouveau compte ou un compte qui n'a pas encore de mot de passe local; les redémarrages ne remplacent pas le mot de passe existant. `ADMIN_EMAILS` reste une liste d'adresses réservées et ne donne pas, à elle seule, les privilèges admin.
5. Configurez la compilation mobile de production avec `--dart-define=API_BASE_URL=https://<nom-du-service>.onrender.com`.

Après le déploiement, vérifiez `https://<nom-du-service>.onrender.com/health`. Render fournit HTTPS et prend en charge WebSocket pour Socket.IO.

## Routes mobiles

- Authentification : `POST /api/auth/register`, `/login`, `/google`, `/facebook`. Toute création publique locale ou OAuth produit un compte `CLIENT`; aucune connexion ne promeut un compte par son adresse e-mail. Les adresses de `ADMIN_EMAILS` sont réservées et refusées par l'inscription locale.
- Provisionnement admin : après vérification de l'identité par l'opérateur, attribuez `role: "ADMIN"` et `adminApproved: true` au compte voulu directement via un outil d'administration MongoDB sécurisé. Ne réutilisez pas un compte/client dont l'identité n'a pas été vérifiée. Le champ `adminApproved` est exigé par la connexion, les routes REST et Socket.IO; les comptes `ADMIN` existants sans approbation sont donc bloqués jusqu'à revue manuelle. Aucun endpoint public ne modifie ces champs.
- Consultations : `GET /api/consultations` (crée/récupère le salon du client ou liste les salons côté admin), `GET/POST /api/consultations/:id/messages`; la gestion de statut est admin uniquement.
- Socket.IO : connexion avec `auth: { token: "<JWT>" }`, puis événement `consultation:join` avec `{ consultationId }`. Envoi par `message:send` avec `{ consultationId, contenu }`; événements entrants `message:new`, `consultation:new` et `consultation:message`.
- Rituels : `GET /api/rituals`; CRUD admin avec `POST/PUT/DELETE /api/rituals/:id`. Les clients commandent via `POST /api/rituals/:id/orders` et suivent leurs commandes sur `/api/rituals/orders/mine`. L’administration traite les demandes sur `GET /api/rituals/orders` et `PUT /api/rituals/orders/:id/status`; un compte-rendu est obligatoire pour le statut `TERMINE`.
- Géomancie : `POST /api/geomancy/readings` avec `{ question }`, et historique utilisateur par `GET /api/geomancy/readings`. Les figures sont générées côté serveur.

La géomancie et les commandes de rituels sont enregistrées par compte utilisateur. Le stockage local des photos de profil convient au développement seulement; utilisez un stockage persistant (par exemple S3/Cloud Storage) en production.

Les requêtes privées utilisent `Authorization: Bearer <JWT>`. Les erreurs JSON ont la forme `{ "message": "..." }`. Les sockets vérifient le même JWT et l'accès à chaque consultation.